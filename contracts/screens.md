# Terminal screens (v1)

Lets the UI show every agent's terminal live, the way the claude4 browser view does, for every laptop on the hub.
Read-only everywhere: nothing in agentlink ever sends keystrokes to a pane because of a screen or a remote message.

## Opt-in

A laptop shares its screens only when its bridge runs with `AGENTLINK_SHARE_SCREENS=1` (`team-up.sh --share-screens`).
Without it, the bridge sends no screens at all. The UI says which users share and which don't.

## Flow

1. **Bridge** (every 1s per pane): `tmux capture-pane -p -e -J -S -<SCREEN_MAX_LINES>`. It strips every escape sequence
   except SGR colour codes (`ESC [ <digits;> m`), redacts (below), and caps the text at SCREEN_MAX_BYTES (dropping the
   oldest lines). It sends only when the text changed, at most 2 per second per pane:
   `PUT /v1/screens/:agent` with `ScreenUpdate` (the daemon's localhost API; 204). `DELETE /v1/screens/:agent` when a slot goes away.
2. **Daemon**: forwards it as `{op:"screen", screen}` while connected. It is never queued or stored: while offline, it keeps
   only the latest per agent and sends those on reconnect. `GET /v1/screens/:agent` returns the latest local one (the local UI may use it).
3. **Hub**: keeps the latest per address in memory only (not in SQLite, not in the event log). It rejects screens over the cap
   or for agents with no session. A screen is dropped when its session goes offline or is removed (`screen.gone` to subscribers).
   UI sockets get screens only for addresses they subscribed to (`screens.subscribe`); right after subscribing they get the
   current screen of each. REST: `GET /api/screens` → `{ screens: ScreenInfo[] }` (no text).
4. **UI**: subscribes to the addresses on screen, renders ANSI SGR as styled spans (no HTML from the text, ever), and never offers input.

## Redaction (bridge, before sending)

Replace with `[redacted]`: the shared token value; anything after `TOKEN=`, `SECRET=`, `PASSWORD=`, `API_KEY=`, `Authorization: Bearer `;
and strings shaped like `sk-…` (20+), `ghp_…`, `github_pat_…`, `xox[abp]-…`, `AKIA[0-9A-Z]{16}`, `-----BEGIN … PRIVATE KEY-----` blocks.
Redaction is best-effort; screen sharing is opt-in because of that.

## Size

5 panes × 2 users × ≤ 2 updates/s × typically < 8 KB. Fine on a LAN; no diffs in v1.
