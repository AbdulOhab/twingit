import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

const execFile = util.promisify(cp.execFile);

const SCM_ID = 'twinGit';
const DIFF_SCHEME = 'twinGitShow';

interface StatusEntry {
  index: string; // staged status char (X)
  working: string; // working-tree status char (Y)
  relPath: string;
}

/**
 * One instance per workspace folder that has the configured secondary
 * git-dir. Wraps that git-dir with its own vscode.scm SourceControl —
 * a sibling to the built-in Git extension's own panel, not a replacement
 * for it. The built-in extension never sees this git-dir; this class talks
 * to it directly via `git --git-dir=<gitDirAbs> --work-tree=<root>`.
 */
class TwinGitRepository implements vscode.Disposable {
  readonly sc: vscode.SourceControl;
  readonly staged: vscode.SourceControlResourceGroup;
  readonly changes: vscode.SourceControlResourceGroup;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public readonly root: string,
    public readonly gitDirAbs: string,
    label: string,
  ) {
    this.sc = vscode.scm.createSourceControl(SCM_ID, label, vscode.Uri.file(root));
    this.sc.inputBox.placeholder = `Message (${label} repo)`;
    this.sc.acceptInputCommand = { command: 'twinGit.commit', title: 'Commit', arguments: [this] };

    this.staged = this.sc.createResourceGroup('staged', 'Staged Changes');
    this.changes = this.sc.createResourceGroup('changes', 'Changes');
    this.staged.hideWhenEmpty = true;

    this.disposables.push(this.sc, this.staged, this.changes);

    const gitDirRel = path.relative(this.root, this.gitDirAbs);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, `${gitDirRel}/{HEAD,index,MERGE_HEAD,refs/**}`),
    );
    watcher.onDidChange(() => this.scheduleRefresh(50));
    watcher.onDidCreate(() => this.scheduleRefresh(50));
    watcher.onDidDelete(() => this.scheduleRefresh(50));
    this.disposables.push(watcher);

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(this.root)) {
          this.scheduleRefresh(300);
        }
      }),
    );

    void this.refresh();
  }

  scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), delayMs);
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFile('git', ['--git-dir', this.gitDirAbs, '--work-tree', this.root, ...args], {
      cwd: this.root,
      maxBuffer: 20 * 1024 * 1024,
    });
  }

  async refresh(): Promise<void> {
    try {
      const { stdout } = await this.run(['status', '--porcelain=v1', '--no-renames', '-z']);
      const entries = this.parseStatus(stdout);

      const stagedStates: vscode.SourceControlResourceState[] = [];
      const changeStates: vscode.SourceControlResourceState[] = [];

      for (const e of entries) {
        const uri = vscode.Uri.file(path.join(this.root, e.relPath));
        if (e.index !== ' ' && e.index !== '?') {
          stagedStates.push(this.toResourceState(uri, e.relPath, e.index, true));
        }
        if (e.working !== ' ') {
          const code = e.working === '?' ? '?' : e.working;
          changeStates.push(this.toResourceState(uri, e.relPath, code, false));
        }
      }

      this.staged.resourceStates = stagedStates;
      this.changes.resourceStates = changeStates;
      this.sc.count = stagedStates.length + changeStates.length;
    } catch (err) {
      console.error('[twingit] refresh failed:', err);
    }
  }

  private parseStatus(stdout: string): StatusEntry[] {
    return stdout
      .split('\0')
      .filter((t) => t.length > 0)
      .map((t) => ({ index: t[0], working: t[1], relPath: t.slice(3) }));
  }

  private toResourceState(
    uri: vscode.Uri,
    relPath: string,
    code: string,
    staged: boolean,
  ): vscode.SourceControlResourceState {
    const { icon, label } = describeCode(code);
    const command: vscode.Command = {
      command: 'twinGit.openChange',
      title: 'Open Change',
      arguments: [{ root: this.root, uri, relPath, staged, code }],
    };
    const contextValue = staged
      ? 'twinGit.staged'
      : code === '?'
        ? 'twinGit.untracked'
        : 'twinGit.unstaged';
    return {
      resourceUri: uri,
      command,
      contextValue,
      decorations: {
        tooltip: `${label}: ${relPath}`,
        strikeThrough: code === 'D',
        iconPath: icon,
      },
    };
  }

  async stage(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return;
    await this.run(['add', '-A', '--', ...relPaths]);
    await this.refresh();
  }

  async unstage(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return;
    await this.run(['reset', '-q', '--', ...relPaths]);
    await this.refresh();
  }

  async stageAll(): Promise<void> {
    await this.run(['add', '-A']);
    await this.refresh();
  }

  async unstageAll(): Promise<void> {
    await this.run(['reset', '-q']);
    await this.refresh();
  }

  async discard(relPath: string, untracked: boolean): Promise<void> {
    if (untracked) {
      await fs.promises.unlink(path.join(this.root, relPath));
    } else {
      await this.run(['checkout', '--', relPath]);
    }
    await this.refresh();
  }

  async commit(message: string): Promise<void> {
    await this.run(['commit', '-m', message]);
    this.sc.inputBox.value = '';
    await this.refresh();
  }

  async push(): Promise<void> {
    await this.run(['push']);
  }

  async pull(): Promise<void> {
    await this.run(['pull']);
    await this.refresh();
  }

  /** ref is 'HEAD', ':' (index), or 'EMPTY' (sentinel for "no content"). */
  async show(ref: string, relPath: string): Promise<string> {
    if (ref === 'EMPTY') return '';
    try {
      const gitRef = ref === ':' ? `:${relPath}` : `${ref}:${relPath}`;
      const { stdout } = await this.run(['show', gitRef]);
      return stdout;
    } catch {
      return '';
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

function describeCode(code: string): { icon: vscode.ThemeIcon; label: string } {
  switch (code) {
    case 'A':
      return { icon: new vscode.ThemeIcon('diff-added'), label: 'Added' };
    case 'D':
      return { icon: new vscode.ThemeIcon('diff-removed'), label: 'Deleted' };
    case '?':
      return { icon: new vscode.ThemeIcon('diff-added'), label: 'Untracked' };
    case 'M':
    default:
      return { icon: new vscode.ThemeIcon('diff-modified'), label: 'Modified' };
  }
}

const repoRegistry = new Map<string, TwinGitRepository>();

function findRepoByGroup(group?: vscode.SourceControlResourceGroup): TwinGitRepository | undefined {
  if (!group) return undefined;
  for (const repo of repoRegistry.values()) {
    if (repo.staged === group || repo.changes === group) return repo;
  }
  return undefined;
}

function findRepoByUri(uri: vscode.Uri): TwinGitRepository | undefined {
  const p = uri.fsPath;
  for (const repo of repoRegistry.values()) {
    if (p === repo.root || p.startsWith(repo.root + path.sep)) return repo;
  }
  return undefined;
}

function groupByRepo(
  states: vscode.SourceControlResourceState[],
): Map<TwinGitRepository, string[]> {
  const map = new Map<TwinGitRepository, string[]>();
  for (const s of states) {
    const repo = findRepoByUri(s.resourceUri);
    if (!repo) continue;
    const relPath = path.relative(repo.root, s.resourceUri.fsPath);
    if (!map.has(repo)) map.set(repo, []);
    map.get(repo)!.push(relPath);
  }
  return map;
}

async function pickRepo(): Promise<TwinGitRepository | undefined> {
  const repos = Array.from(repoRegistry.values());
  if (repos.length === 0) {
    void vscode.window.showWarningMessage('No secondary notes git-dir found in this workspace.');
    return undefined;
  }
  if (repos.length === 1) return repos[0];
  const pick = await vscode.window.showQuickPick(
    repos.map((r) => ({ label: path.basename(r.root), repo: r })),
    { placeHolder: 'Select notes repo' },
  );
  return pick?.repo;
}

class ShowContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const root = params.get('root') ?? '';
    const ref = params.get('ref') ?? '';
    const relPath = params.get('path') ?? '';
    if (ref === 'EMPTY') return '';
    const repo = repoRegistry.get(root);
    if (!repo) return '';
    return repo.show(ref, relPath);
  }
}

function makeShowUri(root: string, ref: string, relPath: string): vscode.Uri {
  const q = new URLSearchParams({ root, ref, path: relPath }).toString();
  return vscode.Uri.parse(`${DIFF_SCHEME}:${encodeURIComponent(relPath)}?${q}`);
}

interface OpenChangeArg {
  root: string;
  uri: vscode.Uri;
  relPath: string;
  staged: boolean;
  code: string;
}

async function openChange(arg: OpenChangeArg): Promise<void> {
  const { root, uri, relPath, staged, code } = arg;

  if (!staged && code === '?') {
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }

  const leftUri = makeShowUri(root, staged ? 'HEAD' : ':', relPath);
  let rightUri: vscode.Uri;
  if (staged) {
    rightUri = makeShowUri(root, ':', relPath);
  } else if (code === 'D') {
    rightUri = makeShowUri(root, 'EMPTY', relPath);
  } else {
    rightUri = uri;
  }

  const title = `${relPath} (${staged ? 'Index ↔ HEAD' : 'Working Tree ↔ Index'})`;
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}

export function activate(context: vscode.ExtensionContext): void {
  const contentProvider = new ShowContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contentProvider),
  );

  const initFolder = (folder: vscode.WorkspaceFolder): void => {
    const cfg = vscode.workspace.getConfiguration('twinGit', folder.uri);
    const gitDirRel = cfg.get<string>('gitDir', '.notes.git');
    const label = cfg.get<string>('label', 'Notes');
    const root = folder.uri.fsPath;
    const gitDirAbs = path.join(root, gitDirRel);

    if (repoRegistry.has(root)) return;
    if (!fs.existsSync(path.join(gitDirAbs, 'HEAD'))) return;

    const repo = new TwinGitRepository(root, gitDirAbs, label);
    repoRegistry.set(root, repo);
    context.subscriptions.push(repo);
  };

  (vscode.workspace.workspaceFolders ?? []).forEach(initFolder);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      e.added.forEach(initFolder);
      e.removed.forEach((folder) => {
        const root = folder.uri.fsPath;
        const repo = repoRegistry.get(root);
        if (repo) {
          repo.dispose();
          repoRegistry.delete(root);
        }
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('twinGit.refresh', async (repo?: TwinGitRepository) => {
      const r = repo instanceof TwinGitRepository ? repo : await pickRepo();
      await r?.refresh();
    }),

    vscode.commands.registerCommand(
      'twinGit.stageAll',
      async (group?: vscode.SourceControlResourceGroup) => {
        const repo = findRepoByGroup(group) ?? (await pickRepo());
        await repo?.stageAll();
      },
    ),

    vscode.commands.registerCommand(
      'twinGit.unstageAll',
      async (group?: vscode.SourceControlResourceGroup) => {
        const repo = findRepoByGroup(group) ?? (await pickRepo());
        await repo?.unstageAll();
      },
    ),

    vscode.commands.registerCommand(
      'twinGit.stage',
      async (
        first?: vscode.SourceControlResourceState,
        all?: vscode.SourceControlResourceState[],
      ) => {
        const states = all && all.length ? all : first ? [first] : [];
        for (const [repo, paths] of groupByRepo(states)) await repo.stage(paths);
      },
    ),

    vscode.commands.registerCommand(
      'twinGit.unstage',
      async (
        first?: vscode.SourceControlResourceState,
        all?: vscode.SourceControlResourceState[],
      ) => {
        const states = all && all.length ? all : first ? [first] : [];
        for (const [repo, paths] of groupByRepo(states)) await repo.unstage(paths);
      },
    ),

    vscode.commands.registerCommand(
      'twinGit.discard',
      async (
        first?: vscode.SourceControlResourceState,
        all?: vscode.SourceControlResourceState[],
      ) => {
        const states = all && all.length ? all : first ? [first] : [];
        if (states.length === 0) return;
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes in ${states.length} file(s)? This cannot be undone.`,
          { modal: true },
          'Discard',
        );
        if (confirm !== 'Discard') return;
        for (const s of states) {
          const repo = findRepoByUri(s.resourceUri);
          if (!repo) continue;
          const relPath = path.relative(repo.root, s.resourceUri.fsPath);
          const untracked = s.contextValue === 'twinGit.untracked';
          await repo.discard(relPath, untracked);
        }
      },
    ),

    vscode.commands.registerCommand('twinGit.commit', async (repo?: TwinGitRepository) => {
      const r = repo instanceof TwinGitRepository ? repo : await pickRepo();
      if (!r) return;
      const message = r.sc.inputBox.value.trim();
      if (!message) {
        void vscode.window.showErrorMessage('Enter a commit message first.');
        return;
      }
      try {
        await r.commit(message);
        vscode.window.setStatusBarMessage('Notes repo: committed', 3000);
      } catch (e) {
        void vscode.window.showErrorMessage(`Commit failed: ${errText(e)}`);
      }
    }),

    vscode.commands.registerCommand('twinGit.push', async (repo?: TwinGitRepository) => {
      const r = repo instanceof TwinGitRepository ? repo : await pickRepo();
      if (!r) return;
      try {
        await r.push();
        vscode.window.setStatusBarMessage('Notes repo: pushed', 3000);
      } catch (e) {
        void vscode.window.showErrorMessage(`Push failed: ${errText(e)}`);
      }
    }),

    vscode.commands.registerCommand('twinGit.pull', async (repo?: TwinGitRepository) => {
      const r = repo instanceof TwinGitRepository ? repo : await pickRepo();
      if (!r) return;
      try {
        await r.pull();
        vscode.window.setStatusBarMessage('Notes repo: pulled', 3000);
      } catch (e) {
        void vscode.window.showErrorMessage(`Pull failed: ${errText(e)}`);
      }
    }),

    vscode.commands.registerCommand('twinGit.openChange', openChange),
  );
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { stderr?: string; message?: string };
    return anyE.stderr?.trim() || anyE.message || String(e);
  }
  return String(e);
}

export function deactivate(): void {
  for (const repo of repoRegistry.values()) repo.dispose();
  repoRegistry.clear();
}
