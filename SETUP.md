# Dual-git setup guide

How to run **two independent git histories over one working tree** — the
pattern TwinGit is built for — from first principles, plus how TwinGit fits
in once it's set up. Two histories means two separate remotes, two separate
commit logs, two separate `git log`s; only the files on disk are shared.

Typical use: a public code repo plus a private repo for notes, scratch work,
internal docs, secrets-adjacent config, or anything else you don't want in
the public repo's history — without keeping it in a separate folder, a
submodule, or a `.gitignore`d dead zone nothing ever commits.

Below, `notes-repo` is used as the example name for the second repo and
`private-docs/`, `NOTES.md` as example paths it owns. Swap in whatever fits
your project.

## The concept

A git repository is really two things kept separate on purpose:

- a **git directory** (normally `.git/`) — the object database, refs, config
- a **work tree** — the actual files you edit

Every `git` command works against *some* git-dir and *some* work tree; it's
just that `git` defaults to "the `.git` next to where I'm standing" so you
never usually have to say so. But both are overridable:

```bash
git --git-dir=<path> --work-tree=<path> <command>
```

That's the entire trick. Point a second, independent git-dir at the *same*
work tree as your first repo, and you have two histories sharing one folder.
Neither repo can see the other's commits, remote, or branches — they only
share the literal files on disk, and even then only the ones each repo's own
ignore rules let it see.

## Initializing from scratch

### 1. The primary repo (normal)

```bash
mkdir myproject && cd myproject
git init
git remote add origin git@github.com:you/myproject.git
```

Nothing unusual yet.

### 2. The second repo, over the same folder

```bash
git init --bare notes-repo
git --git-dir=notes-repo config core.bare false
```

- `--bare` gives it no working tree of its own — correct, since it's going
  to share `myproject/`'s.
- `core.bare false` afterward makes it behave like a normal repo when you
  address it with `--work-tree`, instead of refusing working-tree operations
  the way bare repos do by default.

(Cloning an *existing* second repo onto a new machine works the same way —
`git clone --bare <url> notes-repo` instead of `git init --bare`, then the
same `core.bare false` step, then `git --git-dir=notes-repo --work-tree=. checkout main` to materialize its files into the shared tree.)

### 3. Wire both repos' ignore rules

This is the step that's easy to get wrong, and getting it wrong either
leaks files into the wrong repo's history or makes them invisible to both.

**The primary repo must hide the paths the second repo owns.** Use
`.git/info/exclude`, **not** a tracked `.gitignore`:

```
# .git/info/exclude
/private-docs/
/NOTES.md
/notes-repo/
```

**The second repo must see *only* the paths it owns.** Its
`info/exclude` needs a default-deny-then-allowlist, since by default a
fresh repo tracks everything:

```
# notes-repo/info/exclude
/*
!/private-docs
!/private-docs/**
!/NOTES.md
```

> **Why `.git/info/exclude` and not a tracked `.gitignore`:** a *tracked*
> `.gitignore` in the public repo ships to every clone and every browser of
> your GitHub page — it would list exactly the paths you're trying to keep
> private, advertising that they exist even though their content doesn't.
> `.git/info/exclude` is local-only and never committed, so use it for
> anything you don't want to announce.
>
> **Why the second repo needs `/*` then allowlist, not the other way
> round:** a fresh git repo tracks everything by default. Without the `/*`
> line first, it would see your entire codebase as "untracked," not just
> the paths you want.

### 4. Drive the second repo

Every command needs the `--git-dir`/`--work-tree` flags, so wrap it:

```bash
#!/usr/bin/env bash
# tools/notes-git.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec git --git-dir="$ROOT/notes-repo" --work-tree="$ROOT" "$@"
```

```bash
chmod +x tools/notes-git.sh
tools/notes-git.sh add -A
tools/notes-git.sh commit -m "first notes commit"
tools/notes-git.sh remote add origin git@github.com:you/myproject-notes.git
tools/notes-git.sh push -u origin main
```

### 5. Verify the split

```bash
git status --short                          # primary: clean, no notes paths
tools/notes-git.sh status --short            # notes: clean, in sync
git ls-files | grep -E 'private-docs|NOTES'  # must print NOTHING
```

If that last command prints anything, the primary repo picked up a path it
shouldn't have — fix the exclude file before committing anything.

## Keeping both exclude files in sync (optional, recommended)

The two exclude files list the same paths in opposite polarity, by hand, in
two places — a maintenance risk as the list grows. A small script that
generates both from one manifest avoids that drift:

```bash
# .gitignore.note — source of truth, tracked ONLY by the second repo
# (same leak reasoning as above — don't track this in the primary repo)
private-docs
NOTES.md
```

A generator script reads that list and rewrites the generated portions of
both exclude files. TwinGit doesn't ship this script (it's independent of
the extension), but the pattern is straightforward: read the manifest,
regenerate `notes-repo/info/exclude` in full (`/*` + `!/` per entry), and
replace a marked block inside `.git/info/exclude` (so hand-written entries
elsewhere in that file survive re-runs). Search "dual-git manifest sync
script" in this repo's issue tracker if you'd like a ready-made one, or ask
in a discussion — happy to share the one this pattern was extracted from.

## Where TwinGit comes in

Everything above works from a plain terminal with no extension at all —
TwinGit's job is just to put a Source Control panel on that second repo
instead of you memorizing `--git-dir` flags and running `git status` by
hand.

1. Install TwinGit (see [README.md](README.md#install)).
2. Open the project in VS Code. If `.gitDir` (default `.notes.git` — set
   `twinGit.gitDir` if yours is named differently, e.g. `notes-repo` from
   the example above) has a `HEAD` file, a second panel appears in Source
   Control automatically, labeled by `twinGit.label` (default `Notes`).
3. Stage / commit / push / pull from that panel exactly like the built-in
   one — they're independent, sibling panels, not variants of each other.
4. A status bar item shows that repo's branch and ahead/behind count; click
   it to pull + push in one step.

### Moving a file between the two repos

Right-click a file in either panel → **Move to Code Repo** / **Move to
Notes Repo**. Mechanically this is `git add -f` in the destination repo
(bypasses that repo's own ignore rules for this one explicit file, without
editing any ignore file) plus `git rm --cached` and a permanent per-file
ignore line in the source repo (appended under a marker comment, separate
from any generated block — safe to hand-edit or remove later).

This sidesteps a real git limitation worth knowing about even outside
TwinGit: **you cannot re-include a file with a plain `!pattern` negation if
one of its parent directories is excluded by a directory-match pattern**
(e.g. `/private-docs/`). `git add -f` avoids the problem entirely by
tracking the file explicitly, independent of what the ignore rules say.

## Troubleshooting

- **A GUI git client doesn't show the second repo.** Expected — every
  mainstream git GUI (including VS Code's own built-in Git extension)
  auto-detects repos by looking for a folder literally named `.git`. A
  differently-named git-dir is invisible to them by design (that's what
  makes the "hidden from the public repo" property work at all). TwinGit
  solves this for VS Code specifically by registering its own
  `vscode.scm` provider — see [README.md](README.md).
- **`git add -A` in the second repo picked up nothing.** Check its
  `info/exclude` starts with `/*` — without that, a fresh repo's default is
  "track everything," which isn't what you want here.
- **A file in the primary repo's public history that shouldn't be there.**
  Ignore rules only stop *future* commits. Removing something already
  committed needs history rewriting (`git filter-repo` or similar) plus a
  force-push — take a full `git bundle --all` backup first.
