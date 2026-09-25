# Python Class Map — dev guide

VS Code extension: project-wide Python instantiation explorer. Plain JS, no
build step; the analyzer is stdlib-only Python.

- Install locally after any change: `./install.sh` (builds a vsix via
  `build_vsix.py`, installs with `code --install-extension`), then reload
  the VS Code window. Never install by copying folders into
  `~/.vscode*/extensions` — this machine uses Remote SSH + a non-default
  profile, where folder copies are ignored.
- Test the analyzer directly: `python3 analyzer/analyze.py <root>` → JSON.
- Regenerate README screenshots **from `demo/` only** — never from a private
  codebase; the SVGs embed identifiers and docstrings as searchable text:
  `node scripts/render_demo.js demo images/hero.svg --focus
  expense_tracker.tracker.ExpenseTracker --kinds
  member,transient,received,calls,inherits` then `convert -density 110
  images/hero.svg images/hero.png`. The docstrings shot uses `--focus
  expense_tracker.storage.JsonStore --docs`.
- `demo/expense_tracker` is a runnable expense tracker written to exercise
  all five relationship kinds (it is the only source of README imagery).
- Marketplace publishing: use `npx @vscode/vsce`, not build_vsix.py — see
  PUBLISHING.md. The `repository` URL in package.json is a placeholder that
  must be set first.
- Bump `version` in package.json for every feature change; CHANGELOG.md
  tracks releases.
- Full development history and design decisions: `.claude/CONTEXT.md`
  (untracked).
