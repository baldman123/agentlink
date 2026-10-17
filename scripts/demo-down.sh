#!/usr/bin/env bash
# Stop the demo started by scripts/demo-up.sh for AGENTLINK_BASE_PORT (default 7700).
# Only stops the pids in data/demo-<BASE>/pids, and only if each still looks like an agentlink
# process; anything else listening on the ports is reported, never killed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AGENTLINK_BASE_PORT:-7700}"
DIR="$ROOT/data/demo-$BASE"
PIDFILE="$DIR/pids"

if [[ ! -s "$PIDFILE" ]]; then
  echo "no demo pidfile for base $BASE ($PIDFILE); nothing to stop"
else
  stopping=()
  while read -r name pid; do
    [[ -z "${pid:-}" ]] && continue
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name (pid $pid) already gone"
      continue
    fi
    # guard against pid reuse: only signal our own node processes
    if ! ps -p "$pid" -o command= | grep -q "$ROOT/\(hub\|daemon\)\|src/index.ts"; then
      echo "$name pid $pid is not an agentlink process any more; leaving it alone"
      continue
    fi
    kill -TERM "$pid" 2>/dev/null && stopping+=("$name:$pid")
  done < "$PIDFILE"

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
  rm -f "$PIDFILE"
fi

left="$(lsof -nP -iTCP:"$BASE"-"$((BASE + 2))" -sTCP:LISTEN 2>/dev/null | tail -n +2)"
if [[ -n "$left" ]]; then
  echo "still listening on $BASE-$((BASE + 2)) (not started by this demo, left running):"
  echo "$left"
  exit 1
fi
echo "ports $BASE-$((BASE + 2)) are free"
