#!/usr/bin/env bash
# Join this laptop's claude4 team to agentlink: starts the daemon, the c4 bridge and the UI
# (and the hub, with --host-hub). Safe to run again: anything already running is left alone.
#
#   scripts/team-up.sh --host-hub --user alex          the laptop that hosts the hub
#   bin/agentlink-hub invite sam                            on the host: gives sam a personal token
#   scripts/team-up.sh --user sam --join 3c0f…              each other laptop (id and token from the invite)
#   scripts/team-up.sh --user sam --hub-url https://<app>.vercel.app
#                                                           join the agentlink website instead (asks for
#                                                           your access code; no --join, no --host-hub)
#   scripts/team-up.sh                                      later runs: settings come from data/local.env
#
# Options (env in brackets):
#   --user NAME          [AGENTLINK_USER] this laptop's agentlink username, lowercase
#   --join HUB_ID        [AGENTLINK_HUB_ID] join the hub with this permanent id (the host's team-up prints
#                        it). The daemon finds it wherever it is on the network (mDNS, last address,
#                        subnet scan) and connects to no other hub. Remembered in data/local.env.
#   --hub-url URL        [AGENTLINK_HUB_URL] optional hint for where the hub is. With --join it is only
#                        tried last and still has to prove its id; without --join it is used as is.
#                        An https:// URL is the agentlink website (cloud mode, contracts/cloud-api.md):
#                        the daemon logs in there with your access code [AGENTLINK_HUB_MODE=cloud forces it].
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
#                        [AGENTLINK_UI_PORT] its port, default 7780
#                        [AGENTLINK_UI_ORIGIN] the one web origin allowed to type into the panes through
#                        the command bar; default http://127.0.0.1:7780 (the UI this script starts)
#   --restart-bridge     restart only the c4 bridge (to pick up a new bridge version or a changed
#                        --direct / --share-screens). Hub, daemon and UI are left alone. Settings not
#                        given as flags or env come from the existing data/local.env.
# Token: AGENTLINK_TOKEN, else the one saved in data/.token, else a new one (when hosting) or a prompt.
#   On the host it is the master token, valid only for the host's own --user. Everyone else needs a
#   personal token from `bin/agentlink-hub invite <user>` on the host; it works only for that user name.
#   Cloud mode: AGENTLINK_TOKEN is your access code (from the owner's Admin page or
#   `bin/agentlink-cloud invite <user>`), else the one saved in data/.access-code, else a prompt.
# Files: data/local.env (user, ports, c4 session, direct/share flags; no token), data/.token
#   (data/.access-code in cloud mode), data/team.pids, data/logs/.
# AGENTLINK_DATA_DIR moves all of these (the two-team test uses it to run two users on one machine).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${AGENTLINK_DATA_DIR:-$ROOT/data}"
PIDFILE="$DATA/team.pids"
LOGS="$DATA/logs"
TSX_LOADER="file://$ROOT/node_modules/tsx/dist/loader.mjs"
UI_PORT="${AGENTLINK_UI_PORT:-7780}" # tests move it so they never touch a running UI
# The only web origin the daemon lets type into the panes (the command bar); defaults to this script's UI.
UI_ORIGIN="${AGENTLINK_UI_ORIGIN:-http://127.0.0.1:$UI_PORT}"

USER_NAME="${AGENTLINK_USER:-}"
HUB_URL="${AGENTLINK_HUB_URL:-}"
HUB_ID="${AGENTLINK_HUB_ID:-}"
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
    --join) HUB_ID="${2:-}"; [[ -n "$HUB_ID" ]] || die "--join needs the hub id"; shift 2 ;;
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
    -h | --help) sed -n '2,49p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# Everything else not given as a flag or env var also comes from the earlier run, so a plain
# `scripts/team-up.sh` (or the login agent from scripts/autostart.sh) repeats the last setup.
# The saved C4_SESSION counts as an explicit choice: the person who first ran team-up chose it.
[[ "$RESTART_BRIDGE" != 1 || -f "$DATA/local.env" ]] || die "--restart-bridge: no $DATA/local.env; run team-up.sh normally first"
[[ -n "$USER_NAME" ]] || USER_NAME="$(file_val AGENTLINK_USER)"
[[ -n "$DAEMON_PORT" ]] || DAEMON_PORT="$(file_val AGENTLINK_DAEMON_PORT)"
# Switching between LAN and cloud: what this run asks for (flags or env) beats what local.env remembers,
# and remembered settings that belong to the other mode are dropped (write_local_env rewrites the file).
#   --hub-url https://... on a former LAN host or joiner -> cloud; the old hub port and hub id are ignored
#   --hub-url http://..., --host-hub or --join on a former cloud laptop -> LAN; the remembered website is ignored
URL_GIVEN=0
[[ -n "$HUB_URL" ]] && URL_GIVEN=1
PREV_MODE="$(file_val AGENTLINK_HUB_MODE)"
PREV_URL="$(file_val AGENTLINK_HUB_URL)"
if [[ -z "$HUB_URL" ]]; then
  if [[ "$PREV_MODE" == cloud && ("$HOST_HUB" == 1 || -n "$HUB_ID") ]]; then
    : # back to LAN (--host-hub / --join): the remembered website doesn't apply
  else
    HUB_URL="$(file_val AGENTLINK_HUB_URL)"
  fi
fi
HUB_URL="${HUB_URL%/}"
HUB_MODE="${AGENTLINK_HUB_MODE:-}"
if [[ -z "$HUB_MODE" && "$URL_GIVEN" == 0 && -n "$HUB_URL" ]]; then HUB_MODE="$PREV_MODE"; fi # only with the remembered URL
[[ -z "$HUB_MODE" || "$HUB_MODE" == lan || "$HUB_MODE" == cloud ]] || die "AGENTLINK_HUB_MODE must be lan or cloud"
# Cloud: the hub is the agentlink website (https://...). No hub runs here and there is no hub id to join.
CLOUD=0
if [[ "$HUB_MODE" == cloud || ("$HUB_MODE" != lan && "$HUB_URL" == https://*) ]]; then CLOUD=1; fi
if [[ "$HOST_HUB" != 1 && -z "$HUB_PORT" && -n "$(file_val AGENTLINK_HUB_PORT)" && "$CLOUD" != 1 ]]; then
  HUB_PORT="$(file_val AGENTLINK_HUB_PORT)"
  HOST_HUB=1 # this laptop hosted the hub last time (with --restart-bridge the hub isn't touched)
fi
if [[ "$C4_EXPLICIT" != 1 ]]; then
  c4_file="$(file_val C4_SESSION)"
  if [[ -n "$c4_file" ]]; then C4="$c4_file"; C4_EXPLICIT=1; fi
fi
[[ "$RESTART_BRIDGE" == 1 ]] && START_UI=0

# Hub id. A joining laptop keeps the one it joined (--join is remembered). The host never takes one
# from flags or env: it reads its own hub's id further down (with --restart-bridge, from local.env).
PREV_HUB_ID="$(file_val AGENTLINK_HUB_ID)"
if [[ "$CLOUD" == 1 ]]; then
  [[ "$HOST_HUB" != 1 || "$RESTART_BRIDGE" == 1 ]] || die "--host-hub runs a LAN hub; with an https:// --hub-url the hub is the website"
  [[ -z "$HUB_ID" ]] || die "--join (or AGENTLINK_HUB_ID) is for a LAN hub; the website needs only --hub-url and your access code"
  [[ -n "$HUB_URL" ]] || die "cloud mode needs --hub-url https://<app>.vercel.app"
  HOST_HUB=0
  HUB_ID="" # an earlier LAN run's hub id doesn't apply
elif [[ "$HOST_HUB" == 1 ]]; then
  [[ -z "$HUB_ID" || "$RESTART_BRIDGE" == 1 ]] || die "--host-hub and --join (or AGENTLINK_HUB_ID) don't go together: the host uses its own hub's id"
  HUB_ID="$PREV_HUB_ID"
else
  [[ -n "$HUB_ID" ]] || HUB_ID="$PREV_HUB_ID"
fi
DISCOVERY="${AGENTLINK_DISCOVERY:-}" # passed through to the daemon (tests use manual = no mDNS)
DAEMON_PORT="${DAEMON_PORT:-7701}"
HUB_PORT="${HUB_PORT:-7700}"
[[ "$SHARE" == 1 ]] || SHARE=0

# ---------------------------------------------------------------- checks and config

[[ -f "$ROOT/node_modules/tsx/dist/loader.mjs" ]] || die "dependencies missing; run: cd $ROOT && npm install"
command -v tmux >/dev/null || die "tmux is not installed"
[[ "$USER_NAME" =~ ^[a-z0-9_-]{1,32}$ ]] || die "--user NAME is required (lowercase letters, digits, - or _; up to 32)"
[[ "$DAEMON_PORT" =~ ^[0-9]+$ && "$HUB_PORT" =~ ^[0-9]+$ ]] || die "ports must be numbers"
if [[ -n "$HUB_URL" ]]; then
  [[ "$HUB_URL" =~ ^https?://[^/]+$ ]] || die "--hub-url looks like http://192.168.1.20:7700 or https://<app>.vercel.app (no path)"
fi
if [[ -n "$HUB_ID" ]]; then
  [[ "$HUB_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "--join takes the hub id exactly as team-up printed it on the host"
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

# ---------------------------------------------------------------- switching modes

# A team still running in the other mode (or for another website) would keep its old daemon (and, on a
# former host, the LAN hub others may be using). Stopping that is the person's call, so say how.
if [[ -f "$DATA/local.env" && "$RESTART_BRIDGE" != 1 ]]; then
  prev_cloud=0
  [[ "$PREV_MODE" == cloud ]] && prev_cloud=1
  if [[ "$prev_cloud" != "$CLOUD" || ("$CLOUD" == 1 && "${PREV_URL%/}" != "$HUB_URL") ]]; then
    running=()
    for n in hub daemon bridge; do
      # (live_pid is defined further down; this runs before anything, prompts included)
      pid="$(awk -v n="$n" '$1 == n { p = $2 } END { print p }' "$PIDFILE")"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then running+=("$n"); fi
    done
    if [[ ${#running[@]} -gt 0 ]]; then
      if [[ "$prev_cloud" == 1 ]]; then from="the website ${PREV_URL%/}"; else from="the LAN hub"; fi
      if [[ "$CLOUD" == 1 ]]; then to="the website $HUB_URL"; else to="a LAN hub"; fi
      die "this laptop's team is still running for $from (${running[*]}). To switch to $to, stop it first: scripts/team-down.sh, then run this again"
    fi
  fi
fi

# Token: env, then the saved one, then new (hosting) or asked for (joining).
# --restart-bridge doesn't need it: the bridge only talks to the local daemon.
# Cloud keeps the access code in its own file, so it never mixes with a LAN hub token.
TOKFILE="$DATA/.token"
[[ "$CLOUD" == 1 ]] && TOKFILE="$DATA/.access-code"
TOKEN="${AGENTLINK_TOKEN:-}"
NEW_TOKEN=0
if [[ -z "$TOKEN" && -s "$TOKFILE" ]]; then TOKEN="$(cat "$TOKFILE")"; fi
if [[ "$RESTART_BRIDGE" != 1 ]]; then
  if [[ -z "$TOKEN" ]]; then
    if [[ "$CLOUD" == 1 ]]; then
      if [[ -t 0 ]]; then
        read -r -s -p "agentlink access code for $USER_NAME (from the owner's Admin page on $HUB_URL): " TOKEN
        echo
      fi
    elif [[ "$HOST_HUB" == 1 ]]; then
      TOKEN="$(openssl rand -hex 16)"
      NEW_TOKEN=1
    elif [[ -t 0 ]]; then
      read -r -s -p "agentlink token for $USER_NAME (from 'agentlink-hub invite $USER_NAME' on the hub laptop): " TOKEN
      echo
    fi
  fi
  if [[ "$CLOUD" == 1 ]]; then
    [[ -n "$TOKEN" ]] || die "no access code: set AGENTLINK_TOKEN, or run this in a terminal to be asked for it"
  else
    [[ -n "$TOKEN" ]] || die "no token: set AGENTLINK_TOKEN, or run this in a terminal to be asked for it"
  fi
  (umask 077 && printf '%s\n' "$TOKEN" > "$TOKFILE")
fi

write_local_env() {
  (
    umask 077
    {
      echo "# written by scripts/team-up.sh; read by bin/agentlink. The token is in .token, not here."
      echo "AGENTLINK_USER=$USER_NAME"
      echo "AGENTLINK_DAEMON_PORT=$DAEMON_PORT"
      echo "C4_SESSION=$C4"
      echo "AGENTLINK_BRIDGE_DIRECT=$DIRECT"
      echo "AGENTLINK_SHARE_SCREENS=$SHARE"
      if [[ -n "$HUB_ID" ]]; then echo "AGENTLINK_HUB_ID=$HUB_ID"; fi
      if [[ -n "$HUB_URL" && "$HOST_HUB" != 1 ]]; then echo "AGENTLINK_HUB_URL=$HUB_URL"; fi
      if [[ "$HOST_HUB" == 1 ]]; then echo "AGENTLINK_HUB_PORT=$HUB_PORT"; fi
      if [[ "$CLOUD" == 1 ]]; then echo "AGENTLINK_HUB_MODE=cloud"; fi
    } > "$DATA/local.env"
  )
}

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
# Each process gets a session of its own (setsid) and stdin from /dev/null, so it has no controlling
# terminal: closing the Terminal window can't SIGHUP it. nohup alone isn't enough, because node resets
# SIGHUP to the default at startup. macOS has no setsid(1), so perl's POSIX::setsid does it; the exec
# keeps the pid, which team-down.sh signals. Without perl it falls back to nohup.
if command -v perl >/dev/null 2>&1 && perl -MPOSIX -e 1 2>/dev/null; then
  DETACH=(perl -MPOSIX -e 'POSIX::setsid(); exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n"')
else
  DETACH=(nohup)
fi
launch() {
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec "${DETACH[@]}" "$@") < /dev/null >> "$LOGS/$name.out" 2>&1 &
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
    launch hub "$ROOT/hub" env AGENTLINK_TOKEN="$TOKEN" AGENTLINK_HUB_OWNER="$USER_NAME" AGENTLINK_HUB_PORT="$HUB_PORT" \
      AGENTLINK_HUB_DB="$DATA/hub.sqlite" AGENTLINK_HUB_LOG="$LOGS/hub.log" \
      node --import "$TSX_LOADER" src/index.ts
  fi
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
  hub_health="$(curl -fsS "http://127.0.0.1:$HUB_PORT/api/health" 2>/dev/null)" || die "hub didn't start; see $LOGS/hub.out"
  # The hub's permanent id: what the other laptop joins, and what the host's own daemon pins.
  HUB_ID="$(sed -n 's/.*"hub_id":"\([^"]*\)".*/\1/p' <<< "$hub_health")"
  [[ "$HUB_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "hub on $HUB_PORT gave no usable hub_id in /api/health: $hub_health"
  # The host's own daemon talks to its hub directly.
  [[ -n "$HUB_URL" ]] || HUB_URL="http://127.0.0.1:$HUB_PORT"
fi
write_local_env

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
  # With a hub id the daemon searches for that hub (mDNS, last address, scan, then the --hub-url hint)
  # and refuses any other. The host's own daemon, and a --hub-url without an id, go straight to the URL.
  if [[ -n "$HUB_ID" ]]; then daemon_env+=(AGENTLINK_HUB_ID="$HUB_ID"); fi
  if [[ -n "$HUB_URL" ]]; then
    daemon_env+=(AGENTLINK_HUB_URL="$HUB_URL")
    if [[ "$HOST_HUB" == 1 || -z "$HUB_ID" ]]; then DISCOVERY=manual; fi
  fi
  # cloud: the daemon logs in to the website with the access code (no mDNS, no scan, no pin)
  # cloud: the daemon also mirrors this team's claude4 calls to the website ("Your calls", contracts/calls.ts)
  if [[ "$CLOUD" == 1 ]]; then daemon_env+=(AGENTLINK_HUB_MODE=cloud C4_SESSION="$C4"); fi
  if [[ -n "$DISCOVERY" ]]; then daemon_env+=(AGENTLINK_DISCOVERY="$DISCOVERY"); fi
  launch daemon "$DATA" env -u AGENTLINK_HUB_URL -u AGENTLINK_DISCOVERY -u AGENTLINK_HUB_ID -u AGENTLINK_HUB_MODE "${daemon_env[@]}" \
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
    vite="$(cd "$ROOT/ui" && node -p 'require("path").join(require.resolve("vite/package.json"), "..", "bin", "vite.js")' 2>/dev/null || true)"
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
  echo "  hub page   http://$ip:$HUB_PORT/   (hub id $HUB_ID)"
  echo "  add people bin/agentlink-hub invite <name>     (one per person; prints their token and join command)"
  echo "             bin/agentlink-hub list | revoke <name>"
  if [[ "$NEW_TOKEN" == 1 ]]; then
    echo "  master     new token saved in $TOKFILE. It works only for $USER_NAME; don't give it to anyone."
  else
    echo "  master     token in $TOKFILE (only for $USER_NAME; others get their own with invite)"
  fi
elif [[ "$CLOUD" == 1 ]]; then
  echo "  website    $HUB_URL/   (sign in with your access code; it is saved in $TOKFILE)"
elif [[ -n "$hub_seen" ]]; then
  echo "  hub page   $hub_seen/"
fi
if [[ "$HOST_HUB" != 1 && -n "$HUB_ID" ]]; then
  via="$(sed -n 's/.*"via":"\([a-z_]*\)".*/\1/p' <<< "$health")"
  echo "  joined     hub $HUB_ID${via:+ (found via ${via//_/ })}; no other hub is accepted"
fi
link_note=""
[[ "$CLOUD" == 1 ]] && link_note=" (cloud)"
echo "  hub link   ${state:-unknown}$link_note"
if [[ "$CLOUD" == 1 && "$state" == offline ]]; then
  echo "  (the website refused the access code, or it was revoked; ask the owner for a new one and run"
  echo "   AGENTLINK_TOKEN=<code> scripts/team-up.sh, or delete $TOKFILE to be asked again)"
elif [[ "$state" != connected ]]; then
  echo "  (not connected yet; see the Troubleshooting section of SETUP.md and $LOGS/daemon-$USER_NAME.log)"
fi
echo "  stop with  scripts/team-down.sh"
