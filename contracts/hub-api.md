# Hub API (v1)

Types live in `contracts/index.ts`. This file covers behavior.

Default port 7700 (`AGENTLINK_HUB_PORT`). One HTTP server serves both REST (`/api/*`) and WebSocket (`/ws`).
Binds `0.0.0.0` so LAN peers can reach it. CORS: allow any origin on `/api/*` (the session is the gate), except `/api/admin/*` (no CORS).

## mDNS

Advertise `_agentlink._tcp` on the hub port, instance name = `AGENTLINK_HUB_NAME` (default `agentlink-hub-<hostname>-<port>`),
TXT `{ v: "1", hub_id, name }` where `name` is that same value. Withdraw the advertisement on shutdown.

## Auth

Master token from `AGENTLINK_TOKEN` and the owner's user from `AGENTLINK_HUB_OWNER` (both required; the hub refuses to start without them).
Each person has their own token, and a token works only for its own user name:
- the **owner** (`AGENTLINK_HUB_OWNER`, the host laptop's user) signs with the master token;
- every **invited person** signs with a personal token, `HMAC-SHA256(key=master, "agentlink-person|" + user + "|" + epoch)`, hex
  (`personalToken` in `hub/src/auth.ts`). The hub keeps `people(user, epoch, created_at, invited_at, revoked_at)` in its db and no secret per person;
- anyone else (never invited, or revoked) has no valid key. The master token used under any other user name fails like a wrong token.

Protocol v2: no token ever crosses the network.
- WS: on connect the hub sends `challenge{nonce (32 random bytes, hex), hub_id, hub_name, protocol}`. The client checks `hub_id` against
  its pin (and closes if it differs, sending nothing), then sends `hello{role, user, protocol, since_seq?, cnonce, proof}` (formulas in index.ts).
  The hub picks the key for the hello's `user` (master for the owner, personal for an active invitee, none otherwise) and recomputes `proof`
  with a constant-time compare. Wrong proof, an uninvited or revoked user, an old-protocol hello (has `token` or protocol < 2), or no hello within
  5s → `error{auth_failed}` and close 4001 (4002 for a protocol mismatch). On success it sends `welcome{…, server_proof, session}`, with
  `server_proof` made with that same key. The client verifies `server_proof` before anything else. Nonces are single use.
- REST: `Authorization: Bearer <session>` where session comes from a live socket's welcome (valid while that socket is open plus 60s),
  else 401 `{error:"unauthorized"}`. No token is accepted as a bearer. `GET /api/health` and `GET /` are open.
- Messages themselves still travel unencrypted on the LAN (no TLS in v2): anyone on the network can read message text, but not a token.

## People (invite, revoke)

Admin endpoints under `/api/admin/`, used by `bin/agentlink-hub`. Accepted only from a loopback address (127.0.0.1 / ::1; anything else → 403
`{error:"loopback_only"}`) and only with `Authorization: Admin <master token>` (else 401). They send no CORS headers.

| Method | Path | Result |
|---|---|---|
| GET | `/api/admin/people` | `{ hub_id, hub_name, owner, people: [{ user, epoch, created_at, invited_at, revoked_at, connected }] }` (no tokens) |
| POST | `/api/admin/people` | body `{user}` → `{ user, hub_id, token, epoch, reinvited }`. New user: epoch 1. Existing user (active or revoked): epoch + 1, `revoked_at` cleared, and every socket of theirs is closed (their old token is dead). 400 for a bad name or the owner |
| POST | `/api/admin/people/:user/revoke` | `{ok, user}`; 404 if not an active invitee |

Revoking (or re-inviting) closes every daemon and ui socket of that user at once with `error{auth_failed}` and close 4001, and drops all of their
REST sessions without the 60s grace. Revoked and never-invited users drop out of `snapshot.users` / `GET /api/sessions` (their old sessions stay in
the db), and `*` broadcasts are no longer queued for them. The hub logs `person.invited` / `person.revoked` (user, epoch; never a token).

## What each user can read

Message reads are scoped to the reader's user, everywhere: a user sees a message only if it is from or to one of its own addresses
(`<user>/agent` or `<user>/*`), or is a broadcast to `*`. That covers live `message.accepted` / `message.dropped` / `message.delivered` event
frames, the `since_seq` replay, `GET /api/events`, `GET /api/messages` (always narrowed to the caller, on top of `address` / `with`) and
`GET /api/messages/:id` (404 for someone else's message). Everything else is shared with everyone on the hub: presence and sessions
(with their tasks), context, other events, and screens from teams that turned sharing on.

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
| PUT / GET | `/api/files/:id` | relayed files, daemon sessions only (uploads.md "LAN hub"); 200 MB per file, kept 7 days |

## Persistence (SQLite, `AGENTLINK_HUB_DB`, default `./data/hub.sqlite`)

Tables at minimum: `messages`, `deliveries` (message id × recipient user, acked flag), `sessions`, `context`, `events`.
Restarting the hub keeps history, context, and pending deliveries.

## Logging

One JSON line per message event to stdout and `logs/hub.log`:
`{ ts, component:"hub", event:"msg.accepted"|"msg.delivered"|"msg.dropped"|"msg.rejected", id, from, to, type, hops, reason? }`.
