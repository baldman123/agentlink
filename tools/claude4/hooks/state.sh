#!/bin/sh
# c4 pane state from Claude Code hooks (wired in settings.json).
#   state.sh start  (UserPromptSubmit): @state=working, whatever it was, so typed and pasted prompts both count
#   state.sh stop   (Stop): back to idle, but only if still working; done/blocked/asking set by c4 during the turn stay
# Outside tmux it does nothing. Always exits 0 so it never blocks a prompt or a stop.
[ -n "$TMUX_PANE" ] || exit 0
case "$1" in
  start) tmux set -p -t "$TMUX_PANE" @state working 2>/dev/null ;;
  stop)
    [ "$(tmux show -pqv -t "$TMUX_PANE" @state 2>/dev/null)" = working ] &&
      tmux set -p -t "$TMUX_PANE" @state idle 2>/dev/null ;;
esac
exit 0
