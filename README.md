# TwinGit

Adds a second, independent **Source Control** panel for a secondary git
directory (default: `.notes.git`) that lives in the same working tree as
your main repo — without touching or replacing the built-in Git extension.
Both panels run side by side, each backed by the same official
`vscode.scm` API the built-in Git extension itself uses.

Built for the OpenYog project's two-repo setup (public code in `.git`,
private notes in `.notes.git` over the same working tree), but the git-dir
path and panel label are configurable, so it works for any project using
the same pattern.

## What it does

- On startup, checks each open workspace folder for `<gitDir>/HEAD`
  (`.gitDir` setting, default `.notes.git`). If found, registers a second
  Source Control panel there.
- Shows **Staged Changes** and **Changes** groups, populated from
  `git --git-dir=<gitDir> --work-tree=<root> status --porcelain -z`.
- Stage / unstage / discard (per file or all).
- Commit box wired to the panel's own input box.
- Push / Pull buttons.
- Click a file to open its diff (working tree ↔ index, or index ↔ HEAD for
  staged files).
- Refreshes automatically when the git-dir's `HEAD`/`index`/`refs` change
  (e.g. from a `git commit` you ran in a terminal) or when you save a file.

## Install

1. `npm install`
2. `npm run compile` (or `npm run package` to also produce a `.vsix`)
3. In VS Code: Extensions panel → `...` menu → **Install from VSIX...** →
   pick `twingit-scm.vsix`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `twinGit.gitDir` | `.notes.git` | Path (relative to the workspace folder root) to the secondary git-dir. |
| `twinGit.label` | `Notes` | Label shown for the panel. |

## Notes

- This never modifies, reads config from, or disables the built-in Git
  extension — the code repo's own `.git` keeps working exactly as before.
- Only files already visible to the target git-dir's own
  `info/exclude`/`.gitignore` rules will ever show up here — this
  extension doesn't add its own filtering, it just displays what
  `git status` on that git-dir reports.
