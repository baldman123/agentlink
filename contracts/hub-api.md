# Hub API (v1)

Types live in `contracts/index.ts`. This file covers behavior.

Default port 7700 (`AGENTLINK_HUB_PORT`). One HTTP server serves both REST (`/api/*`) and WebSocket (`/ws`).
Binds `0.0.0.0` so LAN peers can reach it. CORS: allow any origin on `/api/*` (token is the gate).

## mDNS

Advertise `_agentlink._tcp` on the hub port, instance name = `AGENTLINK_HUB_NAME` (default `agentlink-hub-<hostname>-<port>`),
TXT `{ v: "1", hub_id, name }` where `name` is that same value. Withdraw the advertisement on shutdown.

## Auth

Shared token from `AGENTLINK_TOKEN` (required; the hub refuses to start without one).
- WS: first frame `hello` with `token`. Wrong or missing token, or no hello within 5s → `error{auth_failed}` and close 4001.
- REST: `Authorization: Bearer <token>`, else 401 `{error:"unauthorized"}`. `GET /api/health` is open.

## WebSocket `/ws`

Sequence: client `hello` → server `welcome` → server `snapshot` → live `event` frames.
If `since_seq` is set in hello, the server replays stored events with seq > since_seq after the snapshot.

**Daemon role** (one socket per user; a new daemon hello for the same user closes the old socket with 4003):
- `send{envelope}`: hub validates, then replies `accepted{id}` or `rejected{id,reason}`.
  - `envelope.from` user must equal the hello `user` → else `from_mismatch`.
  - `hops > HOP_LIMIT` → store with state `dropped`, `drop_reason:"hop_limit"`, emit `message.dropped`, reply `rejected{hop_limit}`, log it.
  - Duplicate id (retry) → reply `accepted` again, do not re-route.
  - Otherwise persist (state `accepted`), emit `message.accepted`, then route.
- Routing: the hub delivery is a forward, so the delivered copy has `hops + 1`. If that exceeds HOP_LIMIT, drop as above instead of delivering.
  Target `user/agent` → that user's daemon. `user/*` → that user's daemon once. `*` → every connected daemon except the sender's, plus queued for offline users.
  Recipient offline → keep pending; deliver, in order, when its daemon next sends hello.
- `deliver{envelope}` → recipient replies `ack{id}` → hub sets state `delivered`, `delivered_at`, emits `message.delivered`. Unacked deliveries are resent on the next reconnect.
- `session.upsert` / `session.remove` / `heartbeat` maintain the registry; each change emits `session.updated` / `session.removed`.
  A session not heartbeated for 30s, or whose daemon disconnects, becomes `status:"offline"` (kept in the registry, emits `session.updated`).
- Daemon connect/disconnect emits `user.connected` / `user.disconnected`.
- Context writes also send every connected daemon a `deliver` of a `context_update` envelope:
  `from` = the author, `to` = `"<user>/*"`, `body = { text: "<title> updated", context_key }`. These need acks like any delivery.

**UI role**: receives `welcome`, `snapshot`, `event` frames only. Any `send`/`session.*` from a UI socket → `error{protocol}`.

`ping` → `pong` for both roles. Clients should ping every 15s; the server closes sockets silent for 45s.

## REST

| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | `{ ok, hub_id, hub_name, protocol }` (no auth) |
| GET | `/api/sessions` | `{ users: UserPresence[] }` |
| GET | `/api/messages?address=&with=&limit=50&before=<iso>` | `{ messages: StoredMessage[] }` newest first. `address` matches from OR to (broadcasts to `user/*` and `*` count as "to" for every address they reach). `with` narrows to a conversation between `address` and `with`. |
| GET | `/api/messages/:id` | `StoredMessage` or 404 |
| GET | `/api/context?q=` | `{ entries: ContextEntry[] }` sorted by `updated_at` desc; `q` substring-matches key/title/body, case-insensitive |
| GET | `/api/context/:key` | `ContextEntry` or 404 |
| PUT | `/api/context/:key` | body `ContextWrite` → 200 `ContextEntry`; 409 `{error:"conflict", current: ContextEntry}` on version mismatch; 400 on bad key/kind |
| DELETE | `/api/context/:key?author=` | 204; emits `context.deleted` |
| GET | `/api/events?since=<seq>&limit=200` | `{ frames: EventFrame[] }` for backfill |

## Persistence (SQLite, `AGENTLINK_HUB_DB`, default `./data/hub.sqlite`)

Tables at minimum: `messages`, `deliveries` (message id × recipient user, acked flag), `sessions`, `context`, `events`.
Restarting the hub keeps history, context, and pending deliveries.

## Logging

One JSON line per message event to stdout and `logs/hub.log`:
`{ ts, component:"hub", event:"msg.accepted"|"msg.delivered"|"msg.dropped"|"msg.rejected", id, from, to, type, hops, reason? }`.
