#!/usr/bin/env bash
# Build a .vsix and install it via the VS Code CLI (registers in the active
# profile — a plain folder copy is ignored by non-default profiles).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
VSIX="$(python3 "$SRC/build_vsix.py")"
if command -v code >/dev/null 2>&1; then
  code --install-extension "$VSIX"
  echo "Now reload VS Code: Ctrl+Shift+P -> 'Developer: Reload Window'"
else
  echo "'code' CLI not found. Install manually:" >&2
  echo "  Ctrl+Shift+P -> 'Extensions: Install from VSIX...' -> $VSIX" >&2
  exit 1
fi
