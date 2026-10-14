# Daemon localhost API (v1)

Types live in `contracts/index.ts`.

One daemon per user per laptop. Binds **127.0.0.1 only**, port `AGENTLINK_DAEMON_PORT` (default 7701).
CORS: allow `http://localhost:*` and `http://127.0.0.1:*` origins only (the UI calls it from the browser).

## Config (env)

| Var | Meaning |
|---|---|
| `AGENTLINK_USER` | required; this laptop's username, e.g. `alex` |
| `AGENTLINK_TOKEN` | required; shared hub token |
| `AGENTLINK_HUB_URL` | optional manual fallback, e.g. `http://192.168.1.20:7700`. Used when mDNS finds nothing within 5s, or immediately if `AGENTLINK_DISCOVERY=manual` |
| `AGENTLINK_HUB_NAME` | optional; when set, mDNS only accepts a hub whose TXT `name` or `hub_id` equals it (lets several hubs share a network). Discovered hubs are keyed by host:port |
| `AGENTLINK_HUB_REPIN` | `1` = accept a hub whose hub_id differs from the pinned one and re-pin. By default the daemon pins hub_id on first welcome and stays offline on mismatch (`hub.id_changed`) |
| `AGENTLINK_DAEMON_PORT` | default 7701 |
| `AGENTLINK_DAEMON_DB` | default `./data/daemon-<user>.sqlite` |

## Hub link

- Discover `_agentlink._tcp` via mDNS; fall back to `AGENTLINK_HUB_URL`. Keep browsing while disconnected, and fall back again if the hub disappears.
- `hello{role:"daemon", user, since_seq}` → expect `welcome`. Auth failure (4001) → state `offline`, log, retry slowly (30s).
- Reconnect with exponential backoff 0.5s → 10s max, with jitter. State: `connecting` (first attempt), `connected`, `reconnecting`, `offline`.
- On (re)connect, re-send `session.upsert` for every local session, then flush the outbox.
- Heartbeat every 10s with all local agent names. Ping every 15s.

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
