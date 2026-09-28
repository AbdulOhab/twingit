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

  private statusByPath = new Map<string, { code: string; staged: boolean }>();
  private trackedScope = new Set<string>();
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor(
    public readonly root: string,
    public readonly gitDirAbs: string,
    public readonly label: string,
  ) {
    this.sc = vscode.scm.createSourceControl(SCM_ID, label, vscode.Uri.file(root));
    this.sc.inputBox.placeholder = `Message (${label} repo)`;
    this.sc.acceptInputCommand = { command: 'twinGit.commit', title: 'Commit', arguments: [this] };

    this.staged = this.sc.createResourceGroup('staged', 'Staged Changes');
    this.changes = this.sc.createResourceGroup('changes', 'Changes');
    this.staged.hideWhenEmpty = true;

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBarItem.command = { command: 'twinGit.sync', title: 'Sync', arguments: [this] };

    this.disposables.push(this.sc, this.staged, this.changes, this.statusBarItem);

    const gitDirRel = path.relative(this.root, this.gitDirAbs);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, `${gitDirRel}/{HEAD,index,MERGE_HEAD,refs/**}`),
    );
    watcher.onDidChange(() => this.scheduleRefresh(50));
    watcher.onDidCreate(() => this.scheduleRefresh(50));
    watcher.onDidDelete(() => this.scheduleRefresh(50));
    this.disposables.push(watcher);

    // Catches files created/edited/deleted by anything OTHER than a VS Code
    // editor save (a terminal `touch`, an external tool, another process) —
    // onDidSaveTextDocument alone misses those entirely. Scoped to what the
    // git-dir's own info/exclude allowlist actually tracks when we can read
    // it, so this stays cheap even on a large tree; falls back to watching
    // everything if that file is missing or unparseable.
    const treePattern = this.resolveTreeWatchPattern();
    const treeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, treePattern),
    );
    treeWatcher.onDidChange(() => this.scheduleRefresh(300));
    treeWatcher.onDidCreate(() => this.scheduleRefresh(300));
    treeWatcher.onDidDelete(() => this.scheduleRefresh(300));
    this.disposables.push(treeWatcher);

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(this.root)) {
          this.scheduleRefresh(150);
        }
      }),
    );

    void this.refresh();
  }

  /**
   * Reads `<gitDir>/info/exclude`'s `!/…` un-ignore lines (the allowlist
   * pattern this project's .notes.git uses: `/*` then `!/xnote`, `!/WORKLOG.md`,
   * …) and turns them into a glob relative to the work tree, e.g.
   * `{xnote/**,WORKLOG.md,AGENTS.md,plan.md,FEATURES.md}`. Falls back to
   * `**\/*` when there's nothing to parse.
   */
  private resolveTreeWatchPattern(): string {
    try {
      const excludePath = path.join(this.gitDirAbs, 'info', 'exclude');
      const content = fs.readFileSync(excludePath, 'utf8');
      const paths = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('!/'))
        .map((l) => l.slice(2).replace(/\/$/, ''))
        .filter((p) => p.length > 0);
      const unique = Array.from(new Set(paths));
      if (unique.length === 0) return '**/*';
      const globs = Array.from(
        new Set(unique.map((p) => (path.extname(p) ? p : `${p}/**`))),
      );
      return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
    } catch {
      return '**/*';
    }
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
      const statusByPath = new Map<string, { code: string; staged: boolean }>();
      const relPaths = new Set<string>();

      for (const e of entries) {
        relPaths.add(e.relPath);
        const uri = vscode.Uri.file(path.join(this.root, e.relPath));
        if (e.index !== ' ' && e.index !== '?') {
          stagedStates.push(this.toResourceState(uri, e.relPath, e.index, true));
          statusByPath.set(uri.fsPath, { code: e.index, staged: true });
        }
        if (e.working !== ' ') {
          const code = e.working === '?' ? '?' : e.working;
          changeStates.push(this.toResourceState(uri, e.relPath, code, false));
          // Working-tree status takes priority over staged for the Explorer badge.
          statusByPath.set(uri.fsPath, { code, staged: false });
        }
      }

      this.staged.resourceStates = stagedStates;
      this.changes.resourceStates = changeStates;
      this.sc.count = stagedStates.length + changeStates.length;
      this.statusByPath = statusByPath;

      for (const relPath of await this.listCommittedPaths()) relPaths.add(relPath);
      this.trackedScope = this.buildTrackedScope(relPaths);

      decorationProvider.refresh();
      void this.updateStatusBar();
    } catch (err) {
      console.error('[twingit] refresh failed:', err);
    }
  }

  /** Branch name + ahead/behind vs upstream, e.g. "$(sync) Notes: main ↑2 ↓1".
   * Ahead/behind is a purely local comparison against the last-fetched
   * remote-tracking ref — no network call, so this is cheap to run on every
   * refresh. Silently hides the item if there's no commit yet (fresh repo). */
  private async updateStatusBar(): Promise<void> {
    try {
      const { stdout: branchOut } = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.trim();

      let aheadBehind = '';
      try {
        const { stdout } = await this.run([
          'rev-list',
          '--left-right',
          '--count',
          'HEAD...@{upstream}',
        ]);
        const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
        const parts: string[] = [];
        if (ahead > 0) parts.push(`↑${ahead}`);
        if (behind > 0) parts.push(`↓${behind}`);
        aheadBehind = parts.length ? ` ${parts.join(' ')}` : '';
      } catch {
        // no upstream configured — just show the branch name
      }

      this.statusBarItem.text = `$(sync) ${this.label}: ${branch}${aheadBehind}`;
      this.statusBarItem.tooltip = `${this.label} repo (${branch}) — click to sync (pull + push)`;
      this.statusBarItem.show();
    } catch {
      this.statusBarItem.hide();
    }
  }

  async sync(): Promise<void> {
    await this.pull();
    await this.push();
    await this.refresh();
  }

  /** All paths committed at HEAD; empty (not an error) for a brand-new repo with no commits yet. */
  private async listCommittedPaths(): Promise<string[]> {
    try {
      const { stdout } = await this.run(['ls-tree', '-r', '--name-only', 'HEAD']);
      return stdout.split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  private buildTrackedScope(relPaths: Set<string>): Set<string> {
    const scope = new Set<string>();
    for (const relPath of relPaths) {
      const parts = relPath.split('/');
      let cur = this.root;
      for (const part of parts) {
        cur = path.join(cur, part);
        scope.add(cur);
      }
    }
    return scope;
  }

  /** Decoration for the Explorer/open-editors view: real status badge when
   * one exists, otherwise just enough color to cancel the "ignored" fade
   * the built-in Git extension applies (this path IS tracked — just by a
   * different git-dir it doesn't know about). */
  decorationFor(fsPath: string): vscode.FileDecoration | undefined {
    const status = this.statusByPath.get(fsPath);
    if (status) return fileDecorationForCode(status.code, status.staged);
    if (this.trackedScope.has(fsPath)) {
      return {
        color: new vscode.ThemeColor('foreground'),
        tooltip: `Tracked by ${this.label} repo`,
      };
    }
    return undefined;
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

  /** Force-tracks relPath in THIS git-dir even if its own exclude rules would
   * normally hide it (e.g. the `/*` default-deny in a notes-style allowlist). */
  async forceAdd(relPath: string): Promise<void> {
    await this.run(['add', '-f', '--', relPath]);
    await this.refresh();
  }

  /** Removes relPath from THIS git-dir's index if tracked; a no-op (not an
   * error) if it was never tracked here. */
  async removeCached(relPath: string): Promise<void> {
    try {
      await this.run(['rm', '--cached', '-q', '--', relPath]);
    } catch {
      // wasn't tracked here — nothing to remove
    }
    await this.refresh();
  }

  /** Appends a permanent per-file ignore line to THIS git-dir's own
   * info/exclude, so `git status` here stops offering relPath once it's
   * being tracked by the other repo instead. Idempotent. */
  async ignoreOverride(relPath: string): Promise<void> {
    const excludeFile = path.join(this.gitDirAbs, 'info', 'exclude');
    await appendIgnoreOverride(excludeFile, relPath);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

const OVERRIDE_MARKER =
  '# per-file overrides added by TwinGit "Move to other repo" — safe to hand-edit/remove';

/** Appends `/relPath` to excludeFile under a marker comment, creating the
 * file/marker if needed. No-op if that exact line is already present. */
async function appendIgnoreOverride(excludeFile: string, relPath: string): Promise<void> {
  let content = '';
  try {
    content = await fs.promises.readFile(excludeFile, 'utf8');
  } catch {
    // file doesn't exist yet — fine, we'll create it
  }
  const line = `/${relPath}`;
  if (content.split('\n').some((l) => l.trim() === line)) return;
  const needsMarker = !content.includes(OVERRIDE_MARKER);
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  const addition = prefix + (needsMarker ? `\n${OVERRIDE_MARKER}\n` : '') + line + '\n';
  await fs.promises.mkdir(path.dirname(excludeFile), { recursive: true });
  await fs.promises.writeFile(excludeFile, content + addition, 'utf8');
}

/** Runs `git` with plain discovery (no --git-dir override) from root — i.e.
 * against whatever repo `git` would normally find there. In this extension's
 * use, that's always the primary/code repo, since the secondary git-dir is
 * never named `.git` and so is never what plain discovery finds. */
function runPlainGit(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
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

function fileDecorationForCode(code: string, staged: boolean): vscode.FileDecoration {
  switch (code) {
    case 'A':
      return {
        badge: 'A',
        color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
        tooltip: 'Added',
      };
    case 'D':
      return {
        badge: 'D',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        tooltip: 'Deleted',
      };
    case '?':
      return {
        badge: 'U',
        color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
        tooltip: 'Untracked',
      };
    case 'M':
    default:
      return {
        badge: staged ? '●' : 'M',
        color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
        tooltip: staged ? 'Staged' : 'Modified',
      };
  }
}

/**
 * Sits alongside the built-in Git extension's own decorations — it does
 * not replace them. For a path inside this project's notes-repo scope it
 * supplies a color (and a status badge when relevant), which is enough to
 * override the built-in extension's "ignored" fade for that path without
 * touching how it decorates anything else.
 */
class TwinGitDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const repo = findRepoByUri(uri);
    return repo?.decorationFor(uri.fsPath);
  }
}

const decorationProvider = new TwinGitDecorationProvider();

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
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

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

    vscode.commands.registerCommand('twinGit.sync', async (repo?: TwinGitRepository) => {
      const r = repo instanceof TwinGitRepository ? repo : await pickRepo();
      if (!r) return;
      try {
        await r.sync();
        vscode.window.setStatusBarMessage(`${r.label} repo: synced`, 3000);
      } catch (e) {
        void vscode.window.showErrorMessage(`Sync failed: ${errText(e)}`);
      }
    }),

    vscode.commands.registerCommand('twinGit.openChange', openChange),

    // Notes panel → Code repo: force-add there, remove-cached + ignore-override here.
    vscode.commands.registerCommand(
      'twinGit.moveToCode',
      async (
        first?: vscode.SourceControlResourceState,
        all?: vscode.SourceControlResourceState[],
      ) => {
        const states = all && all.length ? all : first ? [first] : [];
        for (const s of states) {
          const repo = findRepoByUri(s.resourceUri);
          if (!repo) continue;
          const relPath = path.relative(repo.root, s.resourceUri.fsPath);
          try {
            await runPlainGit(repo.root, ['add', '-f', '--', relPath]);
            await repo.removeCached(relPath);
            await repo.ignoreOverride(relPath);
            vscode.window.setStatusBarMessage(`Moved ${relPath} to the code repo`, 3000);
          } catch (e) {
            void vscode.window.showErrorMessage(`Move to code repo failed: ${errText(e)}`);
          }
        }
      },
    ),

    // Built-in Git panel → Notes repo: force-add there, remove-cached + ignore-override here.
    vscode.commands.registerCommand(
      'twinGit.moveToNotes',
      async (
        first?: vscode.SourceControlResourceState,
        all?: vscode.SourceControlResourceState[],
      ) => {
        const states = all && all.length ? all : first ? [first] : [];
        for (const s of states) {
          const repo = findRepoByUri(s.resourceUri);
          if (!repo) continue;
          const relPath = path.relative(repo.root, s.resourceUri.fsPath);
          try {
            await repo.forceAdd(relPath);
            await runPlainGit(repo.root, ['rm', '--cached', '-q', '--', relPath]).catch(() => {
              // wasn't tracked in the code repo — nothing to remove
            });
            const codeExclude = path.join(repo.root, '.git', 'info', 'exclude');
            await appendIgnoreOverride(codeExclude, relPath);
            vscode.window.setStatusBarMessage(`Moved ${relPath} to the ${repo.label} repo`, 3000);
          } catch (e) {
            void vscode.window.showErrorMessage(`Move to notes repo failed: ${errText(e)}`);
          }
        }
      },
    ),
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
