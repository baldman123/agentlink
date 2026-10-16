#!/usr/bin/env bash
# Join this laptop's claude4 team to agentlink: starts the daemon, the c4 bridge and the UI
# (and the hub, with --host-hub). Safe to run again: anything already running is left alone.
#
#   scripts/team-up.sh --host-hub --user alex          the laptop that hosts the hub
#   scripts/team-up.sh --user sam --hub-url http://192.168.1.20:7700   the other laptop
#
# Options (env in brackets):
#   --user NAME          [AGENTLINK_USER] this laptop's agentlink username, lowercase
#   --hub-url URL        [AGENTLINK_HUB_URL] the hub's address; without it the daemon finds the hub by mDNS
#   --host-hub           [AGENTLINK_HOST_HUB=1] also run the hub on this laptop
#   --c4-session NAME    [C4_SESSION] default claude4web if ~/.claude4/claude4web exists, else claude4.
#                        Joining claude4/claude4web without this flag asks first (and refuses when
#                        there's no terminal to ask in) unless AGENTLINK_I_MEAN_IT=1.
#   --direct             [AGENTLINK_BRIDGE_DIRECT=1] paste messages for <user>/worker-N into worker N's pane
#   --no-direct          back to the default (worker messages go to the orchestrator)
#   --share-screens      [AGENTLINK_SHARE_SCREENS=1] let everyone on the hub watch this team's terminals,
#                        read-only (see "Live terminals" in SETUP.md). Off until you pass it once.
#   --no-share-screens   turn sharing off again
#                        --direct and --share-screens are remembered in data/local.env, so later runs
#                        keep them. A running bridge keeps its old setting until --restart-bridge.
#   --daemon-port N      [AGENTLINK_DAEMON_PORT] default 7701
#   --hub-port N         [AGENTLINK_HUB_PORT] default 7700 (with --host-hub)
#   --no-ui              don't start the UI
#                        [AGENTLINK_UI_ORIGIN] the one web origin allowed to type into the panes through
#                        the command bar; default http://127.0.0.1:7780 (the UI this script starts)
#   --restart-bridge     restart only the c4 bridge (to pick up a new bridge version or a changed
#                        --direct / --share-screens). Hub, daemon and UI are left alone. Settings not
#                        given as flags or env come from the existing data/local.env.
# Token: AGENTLINK_TOKEN, else the one saved in data/.token, else a new one (when hosting) or a prompt.
# Files: data/local.env (user, ports, c4 session, direct/share flags; no token), data/.token, data/team.pids, data/logs/.
# AGENTLINK_DATA_DIR moves all of these (the two-team test uses it to run two users on one machine).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${AGENTLINK_DATA_DIR:-$ROOT/data}"
PIDFILE="$DATA/team.pids"
LOGS="$DATA/logs"
TSX_LOADER="file://$ROOT/node_modules/tsx/dist/loader.mjs"
UI_PORT=7780
# The only web origin the daemon lets type into the panes (the command bar); defaults to this script's UI.
UI_ORIGIN="${AGENTLINK_UI_ORIGIN:-http://127.0.0.1:$UI_PORT}"

USER_NAME="${AGENTLINK_USER:-}"
HUB_URL="${AGENTLINK_HUB_URL:-}"
HOST_HUB="${AGENTLINK_HOST_HUB:-0}"
C4="${C4_SESSION:-}"
C4_EXPLICIT=0 # set only by --c4-session; C4_SESSION from the env doesn't count (every claude4 pane has it)
DIRECT="${AGENTLINK_BRIDGE_DIRECT:-}"
SHARE="${AGENTLINK_SHARE_SCREENS:-}"
DAEMON_PORT="${AGENTLINK_DAEMON_PORT:-}"
HUB_PORT="${AGENTLINK_HUB_PORT:-}"
START_UI=1
RESTART_BRIDGE=0

die() { echo "team-up: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2 ;;
    --hub-url) HUB_URL="${2:-}"; shift 2 ;;
    --host-hub) HOST_HUB=1; shift ;;
    --c4-session) C4="${2:-}"; C4_EXPLICIT=1; shift 2 ;;
    --direct) DIRECT=1; shift ;;
    --no-direct) DIRECT=0; shift ;;
    --share-screens) SHARE=1; shift ;;
    --no-share-screens) SHARE=0; shift ;;
    --daemon-port) DAEMON_PORT="${2:-}"; shift 2 ;;
    --hub-port) HUB_PORT="${2:-}"; shift 2 ;;
    --no-ui) START_UI=0; shift ;;
    --restart-bridge) RESTART_BRIDGE=1; shift ;;
    -h | --help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# Values from an earlier run's local.env. The file is parsed (KEY=value lines), never sourced.
file_val() { [[ -f "$DATA/local.env" ]] && sed -n "s/^$1=//p" "$DATA/local.env" | tail -n 1 || true; }
PREV_DIRECT="$(file_val AGENTLINK_BRIDGE_DIRECT)"
PREV_SHARE="$(file_val AGENTLINK_SHARE_SCREENS)"
# --direct and --share-screens stick: unless given again (flag or env), keep the earlier choice.
[[ -n "$DIRECT" ]] || DIRECT="$PREV_DIRECT"
[[ -n "$SHARE" ]] || SHARE="$PREV_SHARE"

# --restart-bridge: fill in the rest from the local.env written by the first run. Its C4_SESSION
# counts as an explicit choice, since the person who first ran team-up chose it.
if [[ "$RESTART_BRIDGE" == 1 ]]; then
  [[ -f "$DATA/local.env" ]] || die "--restart-bridge: no $DATA/local.env; run team-up.sh normally first"
  [[ -n "$USER_NAME" ]] || USER_NAME="$(file_val AGENTLINK_USER)"
  [[ -n "$DAEMON_PORT" ]] || DAEMON_PORT="$(file_val AGENTLINK_DAEMON_PORT)"
  [[ -n "$HUB_URL" ]] || HUB_URL="$(file_val AGENTLINK_HUB_URL)"
  if [[ -z "$HUB_PORT" ]]; then
    HUB_PORT="$(file_val AGENTLINK_HUB_PORT)"
    [[ -n "$HUB_PORT" ]] && HOST_HUB=1 # keep the hub line in local.env; the hub itself isn't touched
  fi
  if [[ -z "$C4" || "$C4_EXPLICIT" != 1 ]]; then
    c4_file="$(file_val C4_SESSION)"
    if [[ -n "$c4_file" && "$C4_EXPLICIT" != 1 ]]; then C4="$c4_file"; C4_EXPLICIT=1; fi
  fi
  START_UI=0
fi
DAEMON_PORT="${DAEMON_PORT:-7701}"
HUB_PORT="${HUB_PORT:-7700}"
[[ "$SHARE" == 1 ]] || SHARE=0

# ---------------------------------------------------------------- checks and config

[[ -f "$ROOT/node_modules/tsx/dist/loader.mjs" ]] || die "dependencies missing; run: cd $ROOT && npm install"
command -v tmux >/dev/null || die "tmux is not installed"
[[ "$USER_NAME" =~ ^[a-z0-9_-]{1,32}$ ]] || die "--user NAME is required (lowercase letters, digits, - or _; up to 32)"
[[ "$DAEMON_PORT" =~ ^[0-9]+$ && "$HUB_PORT" =~ ^[0-9]+$ ]] || die "ports must be numbers"
if [[ -n "$HUB_URL" ]]; then
  [[ "$HUB_URL" =~ ^https?://[^/]+$ ]] || die "--hub-url looks like http://192.168.1.20:7700 (no path)"
fi
if [[ -z "$C4" ]]; then
  if [[ -d "$HOME/.claude4/claude4web" ]]; then C4=claude4web; else C4=claude4; fi
fi
[[ "$C4" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--c4-session must be a plain tmux session name"

# The bridge pastes into the named session's panes. Joining a real team (claude4 / claude4web) needs
# a deliberate choice, so a test or a Claude running this script can't hit a live team by accident:
# --c4-session, AGENTLINK_I_MEAN_IT=1, or a yes at the prompt in a real terminal.
if [[ ("$C4" == claude4 || "$C4" == claude4web) && "$C4_EXPLICIT" != 1 && "${AGENTLINK_I_MEAN_IT:-}" != 1 ]]; then
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Connect the claude4 team in tmux session '$C4' to agentlink? [y/N] " yn
    [[ "$yn" == y || "$yn" == Y || "$yn" == yes ]] || die "not connecting; pass --c4-session NAME to choose the session"
  else
    die "refusing to connect the real claude4 session '$C4' without --c4-session $C4 (or AGENTLINK_I_MEAN_IT=1)"
  fi
fi
[[ "$DIRECT" == 1 ]] || DIRECT=0

mkdir -p "$DATA" "$LOGS"
chmod 700 "$DATA"
touch "$PIDFILE"

# Token: env, then the saved one, then new (hosting) or asked for (joining).
# --restart-bridge doesn't need it: the bridge only talks to the local daemon.
TOKFILE="$DATA/.token"
TOKEN="${AGENTLINK_TOKEN:-}"
NEW_TOKEN=0
if [[ -z "$TOKEN" && -s "$TOKFILE" ]]; then TOKEN="$(cat "$TOKFILE")"; fi
if [[ "$RESTART_BRIDGE" != 1 ]]; then
  if [[ -z "$TOKEN" ]]; then
    if [[ "$HOST_HUB" == 1 ]]; then
      TOKEN="$(openssl rand -hex 16)"
      NEW_TOKEN=1
    elif [[ -t 0 ]]; then
      read -r -s -p "agentlink token (from the hub laptop): " TOKEN
      echo
    fi
  fi
  [[ -n "$TOKEN" ]] || die "no token: set AGENTLINK_TOKEN, or run this in a terminal to be asked for it"
  (umask 077 && printf '%s\n' "$TOKEN" > "$TOKFILE")
fi

(
  umask 077
  {
    echo "# written by scripts/team-up.sh; read by bin/agentlink. The token is in .token, not here."
    echo "AGENTLINK_USER=$USER_NAME"
    echo "AGENTLINK_DAEMON_PORT=$DAEMON_PORT"
    echo "C4_SESSION=$C4"
    echo "AGENTLINK_BRIDGE_DIRECT=$DIRECT"
    echo "AGENTLINK_SHARE_SCREENS=$SHARE"
    if [[ -n "$HUB_URL" ]]; then echo "AGENTLINK_HUB_URL=$HUB_URL"; fi
    if [[ "$HOST_HUB" == 1 ]]; then echo "AGENTLINK_HUB_PORT=$HUB_PORT"; fi
  } > "$DATA/local.env"
)

# ---------------------------------------------------------------- process helpers

live_pid() {
  local pid
  pid="$(awk -v n="$1" '$1 == n { p = $2 } END { print p }' "$PIDFILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

record_pid() {
  awk -v n="$1" '$1 != n' "$PIDFILE" > "$PIDFILE.tmp" || true
  echo "$1 $2" >> "$PIDFILE.tmp"
  mv "$PIDFILE.tmp" "$PIDFILE"
}

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# launch NAME DIR CMD...  (CMD is exec'd so the recorded pid is the real process)
launch() {
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec nohup "$@") >> "$LOGS/$name.out" 2>&1 &
  record_pid "$name" "$!"
  echo "started $name (pid $!)"
}

# ---------------------------------------------------------------- hub (optional)

if [[ "$HOST_HUB" == 1 && "$RESTART_BRIDGE" != 1 ]]; then
  if pid="$(live_pid hub)" && [[ -n "$pid" ]]; then
    echo "hub already running (pid $pid)"
  elif listening "$HUB_PORT"; then
    die "port $HUB_PORT is taken by another program; stop it or use --hub-port"
  else
    launch hub "$ROOT/hub" env AGENTLINK_TOKEN="$TOKEN" AGENTLINK_HUB_PORT="$HUB_PORT" \
      AGENTLINK_HUB_DB="$DATA/hub.sqlite" AGENTLINK_HUB_LOG="$LOGS/hub.log" \
      node --import "$TSX_LOADER" src/index.ts
  fi
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1 || die "hub didn't start; see $LOGS/hub.out"
  # The host's own daemon talks to its hub directly.
  [[ -n "$HUB_URL" ]] || HUB_URL="http://127.0.0.1:$HUB_PORT"
fi

# ---------------------------------------------------------------- daemon

if [[ "$RESTART_BRIDGE" == 1 ]]; then
  : # left alone; only its health is read below
elif pid="$(live_pid daemon)" && [[ -n "$pid" ]]; then
  echo "daemon already running (pid $pid)"
elif listening "$DAEMON_PORT"; then
  die "port $DAEMON_PORT is taken by another program (another daemon?); stop it or use --daemon-port"
else
  # The command bar (contracts/input.md): only this origin may type into the panes.
  daemon_env=(AGENTLINK_USER="$USER_NAME" AGENTLINK_TOKEN="$TOKEN" AGENTLINK_DAEMON_PORT="$DAEMON_PORT"
    AGENTLINK_DAEMON_DB="$DATA/daemon-$USER_NAME.sqlite" AGENTLINK_UI_ORIGIN="$UI_ORIGIN")
  if [[ -n "$HUB_URL" ]]; then daemon_env+=(AGENTLINK_HUB_URL="$HUB_URL" AGENTLINK_DISCOVERY=manual); fi
  launch daemon "$DATA" env -u AGENTLINK_HUB_URL -u AGENTLINK_DISCOVERY "${daemon_env[@]}" \
    node --import "$TSX_LOADER" "$ROOT/daemon/src/index.ts"
fi
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$DAEMON_PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.2; done
if [[ "$RESTART_BRIDGE" == 1 ]]; then
  health="$(curl -fsS "http://127.0.0.1:$DAEMON_PORT/v1/health" 2>/dev/null || true)"
  [[ -n "$health" ]] || echo "note: no daemon answering on $DAEMON_PORT; the bridge will keep retrying until it does" >&2
else
  health="$(curl -fsS "http://127.0.0.1:$DAEMON_PORT/v1/health" 2>/dev/null)" || die "daemon didn't start; see $LOGS/daemon.out"
fi
for _ in $(seq 1 75); do
  [[ "$health" == *'"state":"connected"'* || "$RESTART_BRIDGE" == 1 ]] && break
  sleep 0.2
  health="$(curl -fsS "http://127.0.0.1:$DAEMON_PORT/v1/health" 2>/dev/null || true)"
done

# ---------------------------------------------------------------- bridge

# True when pid is this checkout's bridge: team-up starts it with its working directory in bridge/.
is_our_bridge() {
  local cwd
  cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [[ "$cwd" == "$ROOT/bridge" ]]
}

if [[ "$RESTART_BRIDGE" == 1 ]] && pid="$(live_pid bridge)" && [[ -n "$pid" ]]; then
  if is_our_bridge "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; echo "stopped bridge (pid $pid, forced)"; else echo "stopped bridge (pid $pid)"; fi
  else
    die "bridge pid $pid in $PIDFILE is not this checkout's bridge any more; not touching it (remove that line and rerun)"
  fi
fi

if [[ ! -f "$ROOT/bridge/package.json" ]]; then
  echo "bridge not installed yet ($ROOT/bridge/package.json missing); skipping it" >&2
elif pid="$(live_pid bridge)" && [[ -n "$pid" ]]; then
  echo "bridge already running (pid $pid)"
  if [[ "$DIRECT" != "${PREV_DIRECT:-0}" || "$SHARE" != "${PREV_SHARE:-0}" ]]; then
    echo "note: the running bridge still uses the old --direct/--share-screens setting; run scripts/team-up.sh --restart-bridge to apply the new one" >&2
  fi
else
  tmux ${C4_TMUX_SOCKET:+-L "$C4_TMUX_SOCKET"} has-session -t "$C4" 2>/dev/null || echo "note: no tmux session '$C4' yet; the bridge will pick it up when claude4 starts" >&2
  # Run the bridge's `npm start` target ("tsx <entry>") directly under node, so the recorded pid is
  # the bridge itself; fall back to npm start for anything else.
  entry="$(node -e 'const s=require(process.argv[1]).scripts?.start??"";const m=s.match(/^tsx\s+(\S+)$/);process.stdout.write(m?m[1]:"")' "$ROOT/bridge/package.json" 2>/dev/null || true)"
  if [[ -n "$entry" ]]; then bridge_cmd=(node --import "$TSX_LOADER" "$entry"); else bridge_cmd=(npm start); fi
  # The bridge needs the token only to redact it from shared screens. Pass this data dir's token,
  # so a run with AGENTLINK_DATA_DIR never falls back to another folder's .token.
  bridge_tok=()
  [[ -n "$TOKEN" ]] && bridge_tok=(AGENTLINK_TOKEN="$TOKEN")
  launch bridge "$ROOT/bridge" env ${bridge_tok[@]+"${bridge_tok[@]}"} AGENTLINK_USER="$USER_NAME" AGENTLINK_DAEMON_PORT="$DAEMON_PORT" \
    C4_SESSION="$C4" AGENTLINK_BRIDGE_DIRECT="$DIRECT" AGENTLINK_SHARE_SCREENS="$SHARE" AGENTLINK_BRIDGE_DB="$DATA/bridge-$USER_NAME.json" \
    AGENTLINK_BRIDGE_LOG="$LOGS/bridge-$USER_NAME.log" \
    "${bridge_cmd[@]}"
fi

# ---------------------------------------------------------------- UI

if [[ "$START_UI" == 1 ]]; then
  if pid="$(live_pid ui)" && [[ -n "$pid" ]]; then
    echo "UI already running (pid $pid)"
  elif listening "$UI_PORT"; then
    echo "UI port $UI_PORT already in use; assuming the UI is running there"
  else
    vite="$(cd "$ROOT/ui" && node -p 'require.resolve("vite/bin/vite.js")' 2>/dev/null || true)"
    [[ -n "$vite" ]] || die "vite not found; run npm install at $ROOT"
    launch ui "$ROOT/ui" node "$vite" --host 127.0.0.1 --port "$UI_PORT" --strictPort
    for _ in $(seq 1 75); do listening "$UI_PORT" && break; sleep 0.2; done
  fi
fi

# ---------------------------------------------------------------- summary

lan_ip() {
  local ip=""
  if command -v ipconfig >/dev/null; then
    for i in en0 en1 en2 en3 en4; do ip="$(ipconfig getifaddr "$i" 2>/dev/null || true)"; [[ -n "$ip" ]] && break; done
  fi
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ -n "$ip" ]] || ip="<this laptop IP>"
  echo "$ip"
}

state="$(sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' <<< "$health")"
hub_seen="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' <<< "$health")"
echo
mode="messages for workers go to the orchestrator"
[[ "$DIRECT" == 1 ]] && mode="messages for worker-N go straight to worker N"
if [[ "$RESTART_BRIDGE" == 1 ]]; then
  echo "bridge restarted for $USER_NAME (c4 session $C4; $mode); hub, daemon and UI untouched"
else
  echo "agentlink is up for $USER_NAME (c4 session $C4; $mode)"
fi
if [[ "$SHARE" == 1 ]]; then
  echo "  screens    shared with everyone on the hub (read-only; best-effort redaction, see SETUP.md)"
else
  echo "  screens    not shared (add --share-screens to let the other team watch these terminals)"
fi
echo "  app        http://127.0.0.1:$UI_PORT/?daemon=$DAEMON_PORT"
if [[ "$HOST_HUB" == 1 ]]; then
  ip="$(lan_ip)"
  echo "  hub page   http://$ip:$HUB_PORT/"
  echo "  other laptop joins with:  scripts/team-up.sh --user <name> --hub-url http://$ip:$HUB_PORT"
  if [[ "$NEW_TOKEN" == 1 ]]; then
    echo "  token      $TOKEN"
    echo "             (new; saved in $TOKFILE. The other laptop needs it.)"
  else
    echo "  token      saved in $TOKFILE"
  fi
elif [[ -n "$hub_seen" ]]; then
  echo "  hub page   $hub_seen/"
fi
echo "  hub link   ${state:-unknown}"
[[ "$state" == connected ]] || echo "  (not connected yet; see the Troubleshooting section of SETUP.md and $LOGS/daemon-$USER_NAME.log)"
echo "  stop with  scripts/team-down.sh"
