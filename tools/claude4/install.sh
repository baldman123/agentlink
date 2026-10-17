#!/usr/bin/env bash
# Install claude4 and c4 (the four-Claudes-in-tmux team that agentlink connects) for this macOS user.
#
#   tools/claude4/install.sh            install; refuses to replace files that already exist and differ
#   tools/claude4/install.sh --force    replace them (the old copy is kept next to it as <file>.bak)
#   tools/claude4/install.sh --check    only report what is missing or different; changes nothing
#
# Where things go:
#   ~/.local/bin/claude4, ~/.local/bin/c4        the two commands
#   ~/.claude4/hooks/                            permission gate and pane-state hooks (settings.json and
#                                                state-hooks.json are written here with this $HOME in them)
#   ~/.claude4/web/                              the browser view (claude4 --web), plus its one dependency, ws
# Needs zsh, tmux, jq, node and Claude Code (claude) on PATH. It never edits ~/.zshrc; if ~/.local/bin isn't
# on PATH it prints the line to add.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN="$HOME/.local/bin"
C4HOME="$HOME/.claude4"
MODE=install
case "${1:-}" in
  "") ;;
  --force) MODE=force ;;
  --check) MODE=check ;;
  -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "install.sh: unknown option $1 (see --help)" >&2; exit 1 ;;
esac

missing=()
for tool in zsh tmux jq node npm claude; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "install.sh: missing: ${missing[*]} (see CLAUDE.md, step 1)" >&2
  [[ "$MODE" == check ]] || exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The hook settings name the hook scripts by absolute path, so they're written for this $HOME.
cat > "$tmp/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "node $C4HOME/hooks/permission.mjs", "timeout": 3600 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "sh $C4HOME/hooks/state.sh start", "timeout": 5 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "sh $C4HOME/hooks/state.sh stop", "timeout": 5 } ] }
    ]
  }
}
EOF
cat > "$tmp/state-hooks.json" <<EOF
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "sh $C4HOME/hooks/state.sh start", "timeout": 5 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "sh $C4HOME/hooks/state.sh stop", "timeout": 5 } ] }
    ]
  }
}
EOF

# source -> destination, one pair per line
pairs=(
  "$SRC/bin/claude4|$BIN/claude4"
  "$SRC/bin/c4|$BIN/c4"
  "$SRC/hooks/permission.mjs|$C4HOME/hooks/permission.mjs"
  "$SRC/hooks/state.sh|$C4HOME/hooks/state.sh"
  "$tmp/settings.json|$C4HOME/hooks/settings.json"
  "$tmp/state-hooks.json|$C4HOME/hooks/state-hooks.json"
  "$SRC/web/server.js|$C4HOME/web/server.js"
  "$SRC/web/index.html|$C4HOME/web/index.html"
  "$SRC/web/package.json|$C4HOME/web/package.json"
  "$SRC/web/package-lock.json|$C4HOME/web/package-lock.json"
)

conflicts=0
for pair in "${pairs[@]}"; do
  from="${pair%%|*}" to="${pair##*|}"
  if [[ ! -e "$to" ]]; then
    echo "new      $to"
  elif cmp -s "$from" "$to"; then
    echo "same     $to"
  else
    echo "differs  $to"
    conflicts=1
  fi
done

if [[ "$MODE" == check ]]; then exit 0; fi
if [[ "$conflicts" == 1 && "$MODE" != force ]]; then
  echo "install.sh: some files already exist and differ (above). Nothing was changed." >&2
  echo "  Rerun with --force to replace them; each old file is kept as <file>.bak." >&2
  exit 1
fi

mkdir -p "$BIN" "$C4HOME/hooks" "$C4HOME/web"
for pair in "${pairs[@]}"; do
  from="${pair%%|*}" to="${pair##*|}"
  cmp -s "$from" "$to" 2>/dev/null && continue
  [[ -e "$to" ]] && cp -p "$to" "$to.bak"
  cp "$from" "$to"
done
chmod 755 "$BIN/claude4" "$BIN/c4" "$C4HOME/hooks/state.sh"

echo "installing the browser view's dependency (ws) in $C4HOME/web"
(cd "$C4HOME/web" && npm ci --silent --no-audit --no-fund)

echo
echo "claude4 installed."
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    echo "  $BIN is not on your PATH. Add this line to ~/.zshrc, then open a new terminal:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
echo "  try it:  claude4 -h   and   c4 help"
