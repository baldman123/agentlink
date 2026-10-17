#!/usr/bin/env bash
# Stop what scripts/team-up.sh started on this laptop (bridge, daemon, UI, hub), and nothing else.
#   scripts/team-down.sh            stop everything team-up started
#   scripts/team-down.sh --keep-ui  leave the UI running
# Only pids in data/team.pids are signalled, and only if they still look like this checkout's
# processes. AGENTLINK_DATA_DIR selects the data folder, as for team-up.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${AGENTLINK_DATA_DIR:-$ROOT/data}"
PIDFILE="$DATA/team.pids"
KEEP_UI=0
[[ "${1:-}" == "--keep-ui" ]] && KEEP_UI=1

if [[ ! -s "$PIDFILE" ]]; then
  echo "nothing to stop (no $PIDFILE)"
  exit 0
fi

ports=()
for v in AGENTLINK_DAEMON_PORT AGENTLINK_HUB_PORT; do
  p="$(sed -n "s/^$v=//p" "$DATA/local.env" 2>/dev/null)"
  [[ -n "$p" ]] && ports+=("$p")
done

keep=()
stopping=()
# bridge first so it stops pasting, then the daemon, then the rest
for name in bridge daemon ui hub; do
  pid="$(awk -v n="$name" '$1 == n { p = $2 } END { print p }' "$PIDFILE")"
  [[ -z "$pid" ]] && continue
  if [[ "$name" == ui && "$KEEP_UI" == 1 ]]; then
    keep+=("$name $pid")
    continue
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name (pid $pid) was not running"
    continue
  fi
  cmd="$(ps -p "$pid" -o command= 2>/dev/null)"
  if [[ "$cmd" != *"$ROOT"* && "$cmd" != *src/index.ts* && "$cmd" != *vite* && "$cmd" != npm* ]]; then
    echo "$name pid $pid is now a different program; leaving it alone"
    continue
  fi
  kill -TERM "$pid" 2>/dev/null && stopping+=("$name:$pid")
done

for entry in "${stopping[@]+"${stopping[@]}"}"; do
  name="${entry%%:*}" pid="${entry##*:}"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
    echo "stopped $name (pid $pid, forced)"
  else
    echo "stopped $name (pid $pid)"
  fi
done

if [[ ${#keep[@]} -gt 0 ]]; then printf '%s\n' "${keep[@]}" > "$PIDFILE"; else rm -f "$PIDFILE"; fi

for p in "${ports[@]+"${ports[@]}"}"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "note: something else is still listening on port $p (not started by team-up; left running)"
  fi
done
echo "agentlink stopped"
