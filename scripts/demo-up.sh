#!/usr/bin/env bash
# Start a one-machine agentlink demo: hub on BASE, alex daemon on BASE+1, sam daemon on BASE+2.
# Daemons find the hub over mDNS (no manual URL); AGENTLINK_HUB_NAME pins them to this demo's hub so
# another hub on the network is ignored.
#
#   scripts/demo-up.sh              start everything (BASE = AGENTLINK_BASE_PORT, default 7700)
#   scripts/demo-up.sh sam          (re)start just one component: hub | alex | sam
#   DEMO_FRESH=1 scripts/demo-up.sh wipe this demo's databases and logs first (full start only;
#                                   ignored when a component is named)
#
# Token: AGENTLINK_TOKEN if set, else a random one kept in data/.demo-token.
# State, logs and the pidfile live in data/demo-<BASE>/. Stop with scripts/demo-down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AGENTLINK_BASE_PORT:-7700}"
DIR="$ROOT/data/demo-$BASE"
PIDFILE="$DIR/pids"
TSX_LOADER="file://$ROOT/node_modules/tsx/dist/loader.mjs"
HUB_NAME="agentlink-demo-$BASE"

if [[ ! -f "$ROOT/node_modules/tsx/dist/loader.mjs" ]]; then
  echo "tsx is not installed; run npm install at the repo root first" >&2
  exit 1
fi

if [[ -n "${AGENTLINK_TOKEN:-}" ]]; then
  TOKEN="$AGENTLINK_TOKEN"
else
  TOKFILE="$ROOT/data/.demo-token"
  mkdir -p "$ROOT/data"
  if [[ ! -s "$TOKFILE" ]]; then
    (umask 077 && openssl rand -hex 24 > "$TOKFILE")
  fi
  TOKEN="$(cat "$TOKFILE")"
fi

# DEMO_FRESH only applies to a full start; restarting one component keeps the demo's state.
if [[ "${DEMO_FRESH:-}" == "1" && $# -gt 0 ]]; then
  echo "ignoring DEMO_FRESH=1: only a full start (no component arguments) wipes state"
elif [[ "${DEMO_FRESH:-}" == "1" ]]; then
  if [[ -s "$PIDFILE" ]]; then
    echo "demo on $BASE is running; run scripts/demo-down.sh before DEMO_FRESH=1" >&2
    exit 1
  fi
  rm -rf "$DIR"
fi
mkdir -p "$DIR/logs"
touch "$PIDFILE"

port_of() {
  case "$1" in
    hub) echo "$BASE" ;;
    alex) echo $((BASE + 1)) ;;
    sam) echo $((BASE + 2)) ;;
  esac
}

# pid recorded for a component, if that process is still alive
live_pid() {
  local pid
  pid="$(awk -v n="$1" '$1 == n { p = $2 } END { print p }' "$PIDFILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

record_pid() {
  local tmp="$PIDFILE.tmp"
  awk -v n="$1" '$1 != n' "$PIDFILE" > "$tmp" || true
  echo "$1 $2" >> "$tmp"
  mv "$tmp" "$PIDFILE"
}

# A non-owner's personal token: invited once through the hub's loopback admin API, then kept in $DIR.
person_token() {
  local f="$DIR/$1.token" out i
  if [[ ! -s "$f" ]]; then
    for i in $(seq 1 100); do curl -fsS "http://127.0.0.1:$BASE/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
    out="$(curl -fsS -X POST -H "Authorization: Admin $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"user\":\"$1\"}" "http://127.0.0.1:$BASE/api/admin/people")" || { echo "could not invite $1 at the hub on $BASE" >&2; exit 1; }
    (umask 077 && sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p' <<< "$out" > "$f")
  fi
  cat "$f"
}

start() {
  local name="$1" port pid
  port="$(port_of "$name")"
  if pid="$(live_pid "$name")" && [[ -n "$pid" ]]; then
    echo "$name already running (pid $pid)"
    return
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is in use by something this demo did not start; pick another AGENTLINK_BASE_PORT" >&2
    exit 1
  fi
  # `exec` all the way down (subshell -> env -> nohup -> node) so $! is node's own pid,
  # which is what demo-down.sh and the e2e kill -9 step signal.
  if [[ "$name" == hub ]]; then
    (cd "$ROOT/hub" && exec env -u AGENTLINK_HUB_URL \
      AGENTLINK_TOKEN="$TOKEN" AGENTLINK_HUB_OWNER=alex AGENTLINK_HUB_PORT="$port" AGENTLINK_HUB_NAME="$HUB_NAME" \
      AGENTLINK_HUB_DB="$DIR/hub.sqlite" AGENTLINK_HUB_LOG="$DIR/logs/hub.log" \
      nohup node --import "$TSX_LOADER" src/index.ts) >> "$DIR/logs/hub.out" 2>&1 &
  else
    local tok="$TOKEN" # alex owns the hub and uses the master token; sam needs a personal one
    [[ "$name" == alex ]] || tok="$(person_token "$name")"
    (cd "$DIR" && exec env -u AGENTLINK_HUB_URL -u AGENTLINK_DISCOVERY \
      AGENTLINK_USER="$name" AGENTLINK_TOKEN="$tok" AGENTLINK_DAEMON_PORT="$port" \
      AGENTLINK_HUB_NAME="$HUB_NAME" AGENTLINK_DAEMON_DB="$DIR/daemon-$name.sqlite" \
      nohup node --import "$TSX_LOADER" "$ROOT/daemon/src/index.ts") >> "$DIR/logs/$name.out" 2>&1 &
  fi
  pid=$!
  record_pid "$name" "$pid"
  echo "started $name on $port (pid $pid)"
}

wait_for() {
  local name="$1" port url i
  port="$(port_of "$name")"
  if [[ "$name" == hub ]]; then url="http://127.0.0.1:$port/api/health"; else url="http://127.0.0.1:$port/v1/health"; fi
  for i in $(seq 1 100); do
    if [[ "$name" == hub ]]; then
      curl -fsS "$url" >/dev/null 2>&1 && return 0
    else
      curl -fsS "$url" 2>/dev/null | grep -q '"state":"connected"' && return 0
    fi
    sleep 0.2
  done
  echo "$name did not become ready on $port within 20s; see $DIR/logs/$name.out" >&2
  return 1
}

if [[ $# -gt 0 ]]; then
  targets=("$@")
else
  targets=(hub alex sam)
fi
for t in "${targets[@]}"; do
  case "$t" in hub | alex | sam) ;; *) echo "unknown component: $t (hub|alex|sam)" >&2; exit 1 ;; esac
  start "$t"
done
for t in "${targets[@]}"; do wait_for "$t"; done

cat <<EOF
agentlink demo up (base $BASE, hub name $HUB_NAME)
  hub   http://127.0.0.1:$BASE
  alex  http://127.0.0.1:$((BASE + 1))
  sam   http://127.0.0.1:$((BASE + 2))
  UI    ?daemon=$((BASE + 1)) or ?daemon=$((BASE + 2))
  logs  $DIR/logs
stop with: AGENTLINK_BASE_PORT=$BASE scripts/demo-down.sh
EOF
