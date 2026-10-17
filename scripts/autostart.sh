#!/usr/bin/env bash
# Start this laptop's agentlink team at login and keep it running, with a per-user LaunchAgent (macOS).
#
#   scripts/autostart.sh install     write ~/Library/LaunchAgents/com.agentlink.team.plist and load it
#   scripts/autostart.sh uninstall   unload it and delete the plist (the running team is left alone;
#                                    scripts/team-down.sh stops it)
#   scripts/autostart.sh status      is it installed and loaded, what is it running, recent log lines
#
# The agent runs `scripts/autostart.sh run`: a loop that calls scripts/team-up.sh with the settings
# saved in data/local.env every 30s. team-up starts only what isn't running, so a daemon or bridge
# that died comes back within 30s. launchd restarts the loop itself if it exits (KeepAlive).
# Run team-up.sh once by hand first: it saves the settings and the token this relies on.
# Logs: data/logs/autostart.log (only starts and failures) and data/logs/autostart.out (launchd's).
#
# Test hooks (never needed for real use):
#   AGENTLINK_AUTOSTART_LABEL   another label, e.g. com.agentlink.test-q3 (must start com.agentlink.)
#   AGENTLINK_AUTOSTART_CMD     run this program instead of the loop
#   AGENTLINK_DATA_DIR          as for team-up.sh; recorded in the plist
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${AGENTLINK_DATA_DIR:-$ROOT/data}"
LOGS="$DATA/logs"
LABEL="${AGENTLINK_AUTOSTART_LABEL:-com.agentlink.team}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
INTERVAL=30

die() { echo "autostart: $*" >&2; exit 1; }

[[ "$LABEL" =~ ^com\.agentlink\.[a-z0-9.-]+$ ]] || die "label must look like com.agentlink.<name> (got '$LABEL')"

xml_escape() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }

# A PATH that has node and tmux in it: launchd starts agents with only /usr/bin:/bin:/usr/sbin:/sbin.
agent_path() {
  local p="/usr/bin:/bin:/usr/sbin:/sbin" d
  for tool in node tmux; do
    d="$(dirname "$(command -v "$tool" 2>/dev/null || echo /nonexistent/x)")"
    [[ -d "$d" && ":$p:" != *":$d:"* ]] && p="$d:$p"
  done
  echo "$p"
}

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-}" in
  install)
    [[ "$(uname)" == Darwin ]] || die "this uses macOS launchd; on other systems start scripts/team-up.sh from your login scripts"
    if [[ -z "${AGENTLINK_AUTOSTART_CMD:-}" ]]; then
      [[ -f "$DATA/local.env" ]] || die "no $DATA/local.env yet; run scripts/team-up.sh once by hand first"
      [[ -s "$DATA/.token" ]] || die "no $DATA/.token yet; run scripts/team-up.sh once by hand first"
      command -v node >/dev/null || die "node is not on PATH"
      command -v tmux >/dev/null || die "tmux is not on PATH"
      program=(/bin/bash "$ROOT/scripts/autostart.sh" run)
    else
      [[ -x "$AGENTLINK_AUTOSTART_CMD" ]] || die "AGENTLINK_AUTOSTART_CMD is not an executable file"
      program=("$AGENTLINK_AUTOSTART_CMD")
    fi
    mkdir -p "$LOGS" "$(dirname "$PLIST")"
    args_xml=""
    for a in "${program[@]}"; do args_xml+="    <string>$(xml_escape "$a")</string>"$'\n'; done
    env_xml="    <key>PATH</key><string>$(xml_escape "$(agent_path)")</string>"$'\n'
    if [[ -n "${AGENTLINK_DATA_DIR:-}" ]]; then
      env_xml+="    <key>AGENTLINK_DATA_DIR</key><string>$(xml_escape "$AGENTLINK_DATA_DIR")</string>"$'\n'
    fi
    tmp="$PLIST.tmp.$$"
    cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
$args_xml  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
$env_xml  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>$INTERVAL</integer>
  <!-- unloading the agent must not take the running team down with it; team-down.sh does that -->
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOGS/autostart.out")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOGS/autostart.out")</string>
</dict>
</plist>
EOF
    plutil -lint "$tmp" >/dev/null || { rm -f "$tmp"; die "generated plist is invalid"; }
    if loaded; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi
    mv "$tmp" "$PLIST"
    launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed; see $PLIST"
    echo "installed $LABEL ($PLIST); it starts now and at every login"
    echo "  log    $LOGS/autostart.log"
    echo "  undo   scripts/autostart.sh uninstall"
    ;;

  uninstall)
    if loaded; then
      launchctl bootout "$DOMAIN/$LABEL" && echo "unloaded $LABEL"
    else
      echo "$LABEL is not loaded"
    fi
    if [[ -f "$PLIST" ]]; then rm -f "$PLIST" && echo "removed $PLIST"; else echo "no $PLIST"; fi
    echo "the team itself keeps running; scripts/team-down.sh stops it"
    ;;

  status)
    if [[ -f "$PLIST" ]]; then echo "plist    $PLIST"; else echo "plist    not installed ($PLIST)"; fi
    if loaded; then
      info="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"
      state="$(sed -n 's/^[[:space:]]*state = //p' <<< "$info" | head -n 1)"
      pid="$(sed -n 's/^[[:space:]]*pid = //p' <<< "$info" | head -n 1)"
      last="$(sed -n 's/^[[:space:]]*last exit code = //p' <<< "$info" | head -n 1)"
      echo "launchd  loaded, ${state:-unknown}${pid:+ (pid $pid)}${last:+, last exit $last}"
    else
      echo "launchd  not loaded"
    fi
    if [[ -f "$LOGS/autostart.log" ]]; then
      echo "log      $LOGS/autostart.log (last lines):"
      tail -n 5 "$LOGS/autostart.log" | sed 's/^/  /'
    fi
    ;;

  run)
    # The loop launchd keeps alive. Quiet unless something was (re)started or team-up failed.
    mkdir -p "$LOGS"
    log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOGS/autostart.log"; }
    log "autostart loop started (pid $$, every ${INTERVAL}s)"
    trap 'log "autostart loop stopped"; exit 0' TERM INT
    while true; do
      if [[ ! -f "$DATA/local.env" ]]; then
        log "no $DATA/local.env; run scripts/team-up.sh once by hand"
      elif out="$("$ROOT/scripts/team-up.sh" </dev/null 2>&1)"; then
        started="$(grep -E '^(started|stopped) ' <<< "$out" || true)"
        [[ -n "$started" ]] && log "team-up: $(tr '\n' ';' <<< "$started")"
      else
        log "team-up failed: $(tail -n 3 <<< "$out" | tr '\n' ' ')"
      fi
      sleep "$INTERVAL" &
      wait $! || true
    done
    ;;

  *)
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
