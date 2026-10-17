# Daemon localhost API (v1)

Types live in `contracts/index.ts`.

One daemon per user per laptop. Binds **127.0.0.1 only**, port `AGENTLINK_DAEMON_PORT` (default 7701).
CORS: allow `http://localhost:*` and `http://127.0.0.1:*` origins only (the UI calls it from the browser).

## Config (env)

| Var | Meaning |
|---|---|
| `AGENTLINK_USER` | required; this laptop's username, e.g. `alex` |
| `AGENTLINK_TOKEN` | required; this user's hub token: the master token on the hub owner's laptop, else the personal token from `agentlink-hub invite <user>` (it works only for this `AGENTLINK_USER`) |
| `AGENTLINK_HUB_URL` | optional manual fallback, e.g. `http://192.168.1.20:7700`. Used when mDNS finds nothing within 5s, or immediately if `AGENTLINK_DISCOVERY=manual`. An `https://` URL is the agentlink website: cloud mode (below) |
| `AGENTLINK_HUB_MODE` | `cloud` or `lan`. Default: `cloud` when `AGENTLINK_HUB_URL` is `https://`, else `lan`. `cloud` with an `http://` URL is for tests; `lan` keeps an https LAN hub on the WebSocket link |
| `AGENTLINK_HUB_NAME` | optional; when set, mDNS only accepts a hub whose TXT `name` or `hub_id` equals it (lets several hubs share a network). Discovered hubs are keyed by host:port |
| `AGENTLINK_HUB_REPIN` | `1` = accept a hub whose hub_id differs from the pinned one and re-pin. By default the daemon pins hub_id on first welcome and stays offline on mismatch (`hub.id_changed`) |
| `AGENTLINK_HUB_ID` | the hub to join, by its permanent id (from the host's `team-up` output or its hub page). Set by `team-up --join`. When set, the daemon pins it from the start and connects to nothing else |
| `AGENTLINK_SCAN` | default `1`: when mDNS and the last known address fail, probe the local subnet for the hub (see Discovery). `0` disables it |
| `AGENTLINK_DAEMON_PORT` | default 7701 |
| `AGENTLINK_DAEMON_DB` | default `./data/daemon-<user>.sqlite` |

## Discovery (finding the pinned hub when its IP changes)

The hub's identity is its `hub_id`, never its IP. With a pin (`AGENTLINK_HUB_ID`, or the id pinned at the first welcome), try these in order and stop at the first match:
1. **mDNS**: a `_agentlink._tcp` service whose TXT `hub_id` equals the pin.
2. **Last known**: every address this daemon has connected to successfully (stored in its db, newest first, at most 5).
3. **Scan** (if `AGENTLINK_SCAN` is on): every host in each private IPv4 subnet this laptop is on (10/8, 172.16/12, 192.168/16, capped at the /24 around this laptop's address), on port 7700 (or the last known hub port), with `GET /api/health` (no auth, 400ms timeout, 32 at a time). Accept only a matching `hub_id`. Repeat every 30s while not connected.
4. **Manual** `AGENTLINK_HUB_URL`, verified the same way.

The token is sent only after `GET /api/health` at that address returns the pinned `hub_id` (and again at welcome). Restart discovery right away when the laptop's network interfaces change (polled every 5s) or the connection drops. Log `hub.found {via, url}` and `hub.search {stage}`.
`DaemonHealth.hub` reports `via`, `hub_id` and `searching` (true while looking).
Tests may set `AGENTLINK_SCAN_HOSTS` (comma-separated host list, which replaces the subnet).

## Hub link

- Discover `_agentlink._tcp` via mDNS; fall back to `AGENTLINK_HUB_URL`. Keep browsing while disconnected, and fall back again if the hub disappears.
- `hello{role:"daemon", user, since_seq}` → expect `welcome`. Auth failure (4001) → state `offline`, log, retry slowly (30s).
- Reconnect with exponential backoff 0.5s → 10s max, with jitter. State: `connecting` (first attempt), `connected`, `reconnecting`, `offline`.
- On (re)connect, re-send `session.upsert` for every local session, then flush the outbox.
- Heartbeat every 10s with all local agent names. Ping every 15s.

## Cloud hub link (`AGENTLINK_HUB_MODE=cloud`)

The hub is the website (`cloud-api.md`). `AGENTLINK_TOKEN` is this person's access code (the master code for the owner). No mDNS, no
scan, no hub_id pin. `DaemonHealth.hub` reports `url` = the website, `via: "manual"`, `hub_name`/`hub_id` from login, `searching: false`.
`GET /v1/ui-bootstrap` gives `hub_ws: null` (there is no hub socket; the website's live feed is Supabase Realtime).
- **Login** `POST /api/auth/login {code, user}`. The code goes only in this body; every later call sends `Authorization: Bearer <session>`.
  401 `bad_code` → `offline`, next try in 8 minutes (the API locks an IP out after 10 failed logins in 15 minutes, and that IP may be a
  household). 429 → `offline`, retry after `retry_after_s`. 403 `revoked`, any `401 {error:"revoked"}`, or the `revoked` broadcast on
  `user:<user>` → `offline` and never retried until the daemon is restarted (with a new code).
- **Tokens.** The Realtime JWT (15 min) is refreshed with `POST /api/auth/refresh` at 2/3 of its life and pushed to the socket
  (`realtime.setAuth`). Any other 401 → log in again once and repeat the call.
- **Realtime** (`@supabase/supabase-js` 2.117.2): `postgres_changes` INSERT on `deliveries` filtered `username=eq.<user>`; private
  `user:<user>` (kick), `screens` (who is watching), `presence` (this daemon tracks key `<user>`, `{user, kind:"daemon", at}`) and
  `input:<user>` (input.md "Cloud input"). A failed join rebuilds the client after 2s; realtime-js rejoins after drops by itself.
- **Up** = logged in, every channel joined, and the resume done: `GET /api/deliveries?since_seq=<last>&limit=500` (paged), each delivery
  stored like a LAN `deliver` (hop limit, dedupe by id), acked with `POST /api/deliveries/ack`, and its seq kept in the db (`cloud_last_seq`,
  separate from the LAN `last_seq`). The resume runs again whenever Realtime rejoins. Then sessions are PUT, the outbox is flushed in
  order, and heartbeats start (`POST /api/heartbeat` every 10s).
- **Outbox.** `POST /api/messages {envelope}`: 2xx → dequeue; 422 (or another 4xx except 401/408/429) → dequeue and a local `status`
  note with the reason, as for a LAN `rejected`; network errors, 429 and 5xx → kept in order and resent with the usual backoff.
- **Screens** go out as `POST /api/screens {screen}`, at most one per pane per 3s (the latest), only while a `screens` presence entry
  other than this daemon's own watches `*`, `<user>/*` or that pane. A removed screen or session sends `POST /api/screens/gone {agent}`.
- Proxied reads (`/v1/context*`, `/v1/peers`, `/v1/messages`) go to the same paths with the session.

## Outbox (durable, SQLite)

`POST /v1/send` builds the envelope (uuid id, `from = <user>/<from_agent>`, `hops = req.hops ?? 0`, timestamp now) and stores it in the outbox **before** responding.
Sent in order while connected. An item stays until the hub replies `accepted{id}` (remove) or `rejected{id}` (remove, log, and put a local
`status` note in the inbox of the sending agent with `body.text` = the reason). Unanswered after 5s → resend with backoff. Survives a daemon restart.

## Inbox (durable, SQLite)

On `deliver{envelope}`: store it (dedupe by id), then reply `ack{id}`. `remote = (envelope.from user != AGENTLINK_USER)`.
Addressing: `user/agent` lands in that agent's inbox; `user/*` and `*` land in every local agent's inbox view (one row; the filter matches it).

## Endpoints

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/v1/health` | | `DaemonHealth` |
| GET | `/v1/ui-bootstrap` | | `UiBootstrap` (hub URLs + token for the local UI; localhost only) |
| POST | `/v1/send` | `SendRequest` | 202 `SendResponse`. 400 bad address/type. 422 `{error:"hop_limit"}` if `hops > 5` (also logged) |
| GET | `/v1/inbox` | `?agent=orchestrator&unhandled=1&since=<iso>&limit=100` | `{ messages: InboxItem[] }` oldest first |
| GET | `/v1/inbox/stream` | `?agent=` | Server-Sent Events, `event: message`, `data: InboxItem` for each new arrival |
| POST | `/v1/inbox/:id/ack` | | 204; marks `handled` (local only; transport acks happen automatically) |
| GET | `/v1/outbox` | | `{ items: OutboxItem[] }` |
| GET | `/v1/context` | `?q=` | proxied hub `GET /api/context` |
| GET | `/v1/context/:key` | | proxied |
| PUT | `/v1/context/:key` | `{title, kind, body, base_version?, agent?}` | proxied; daemon fills `author = <user>/<agent ?? "orchestrator">`. 503 `{error:"hub_offline"}` when not connected |
| GET | `/v1/peers` | | proxied hub `GET /api/sessions` |
| GET | `/v1/messages` | same query as hub | proxied hub `GET /api/messages` |
| PUT | `/v1/sessions/:agent` | `{kind, status, task}` | 200 `Session` (local view); registers/updates the session and forwards `session.upsert` |
| DELETE | `/v1/sessions/:agent` | | 204; forwards `session.remove` |

Errors are JSON `{ error: string, detail?: string }`.

## Logging

JSON lines to stdout and `logs/daemon-<user>.log`:
`{ ts, component:"daemon", user, event:"msg.queued"|"msg.sent"|"msg.accepted"|"msg.rejected"|"msg.received"|"msg.dropped", id, from, to, type, hops }`, plus `hub.connected` / `hub.disconnected` / `hub.discovered`.
