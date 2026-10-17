# Cloud API (v1)

The hosted hub: a Next.js app on Vercel (`cloud/`) plus Supabase (Postgres + Realtime). Plan: `CLOUD-PLAN.md`.
Shared types (`Envelope`, `StoredMessage`, `Session`, `ContextEntry`, `ScreenUpdate`, ...) are the ones in `index.ts`.
The LAN hub (`hub-api.md`) keeps working; this file is the cloud equivalent. Nothing on the server runs Claude.

Base URL: `https://<app>.vercel.app` (dev: `http://127.0.0.1:3000`). All bodies JSON. Errors: `{ error: string, detail?: string }`.

## Server env (Vercel)

| Var | Meaning |
|---|---|
| `AGENTLINK_OWNER` | the owner's user name (Bryant's), lowercase `[a-z0-9_-]{1,32}` |
| `AGENTLINK_MASTER_CODE` | the owner's access code. Works only as the owner |
| `AGENTLINK_SESSION_SECRET` | HS256 key for API session tokens (32+ random bytes) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | public; handed to clients by `/api/config` and login |
| `SUPABASE_SERVICE_ROLE_KEY` | server only; every DB write and the Realtime broadcasts use it |
| `SUPABASE_JWT_SECRET` | HS256 key for the Realtime/DB JWTs the API mints |
| `AGENTLINK_HUB_NAME` | optional display name (default `agentlink-cloud`) |

## Identity and auth

**Access codes.** The owner signs in with `AGENTLINK_MASTER_CODE`. Everyone else has a personal code made by
`POST /api/admin/people` (or `bin/agentlink-cloud invite <name>`): `alc_` + 32 random bytes base64url. The database keeps only
`sha256(code)` (hex) and an `epoch`. Re-inviting makes a new code and bumps the epoch; revoking sets `revoked_at`. A code
identifies its user by itself; a login that also names a `user` must match it.

**API session.** Login returns `session`: a JWT (HS256, `AGENTLINK_SESSION_SECRET`), claims `{ sub: user, epoch, typ: "session", iat, exp }`,
valid 30 days. The owner's epoch is 0. Clients send it two ways:
- daemons and CLIs: `Authorization: Bearer <session>`;
- the browser: the httpOnly cookie `al_session` that login sets (`HttpOnly; SameSite=Lax; Path=/; Secure` on https; Max-Age 30 days).
  A state-changing request (POST/PUT/DELETE) that authenticates by cookie must carry an `Origin` equal to the site's own origin, else 403
  `{error:"bad_origin"}`. Bearer requests skip the Origin check.

On every request the API re-checks the session against the `people` row: unknown user, `revoked_at` set, or a different epoch → 401
`{error:"revoked"}` (the client should stop and ask for a new code). The owner's session dies if `AGENTLINK_OWNER` changes.

**Realtime/DB JWT.** Login, refresh and `/api/me` return a Supabase JWT for the caller (HS256, `SUPABASE_JWT_SECRET`), TTL 15 minutes,
claims `{ sub: user, role: "authenticated", aud: "authenticated", app_user: user, epoch, iat, exp }`. Clients use it only to read
(Supabase Realtime and, if they want, PostgREST selects); every write goes through this API. RLS also checks `epoch` against `people`, so
a revoked or re-invited person's outstanding JWT stops reading at once, not after 15 minutes.

**Login rate limit.** Failed logins are recorded per client IP (`x-forwarded-for` first hop). More than 10 failures from one IP in
15 minutes, or more than 200 failures in total in 15 minutes, → 429 `{error:"rate_limited", retry_after_s}` for that IP (or everyone),
checked before the code is compared. Successful logins are not counted.

## Public routes

| Method | Path | Result |
|---|---|---|
| GET | `/api/health` | `{ ok: true, hub_id, hub_name, protocol: "cloud-1" }` |
| GET | `/api/config` | `{ supabase_url, supabase_anon_key, hub_id, hub_name }` (both values are public by design) |

`hub_id` is a stable id stored in the database (`settings.hub_id`, a uuid made on first use).

## Auth routes

### `POST /api/auth/login`
Body `{ code: string, user?: string }`. Response 200, plus the `al_session` cookie:
```json
{ "user": "sam", "owner": false, "session": "<jwt>", "session_expires_at": "<iso>",
  "hub_id": "…", "hub_name": "agentlink-cloud",
  "realtime": { "url": "<SUPABASE_URL>", "anon_key": "<anon>", "jwt": "<supabase jwt>", "jwt_expires_at": "<iso>" } }
```
401 `{error:"bad_code"}` (unknown code, or `user` doesn't match it). 403 `{error:"revoked"}` (the code belonged to a revoked person).
429 as above. The master code logs in as `AGENTLINK_OWNER` (and makes sure the owner's `people` row exists, `is_owner = true`, epoch 0).

### `POST /api/auth/refresh`
Auth required. Same 200 shape as login (a fresh `realtime.jwt`; `session` is re-issued with a new 30-day expiry). 401 → log in again.

### `POST /api/auth/logout`
Clears the cookie. 204. (Sessions are stateless; revoking a person is what kills their tokens.)

### `GET /api/me`
`{ user, owner, realtime: {…as login…} }`. The browser calls this on load (cookie) to get its JWT.

### `GET /api/snapshot`
The LAN hub's `snapshot` frame shape: `{ users: UserPresence[], context: ContextEntry[], last_seq: 0 }` (users as in `GET /api/sessions`).
The cloud has no event sequence; live changes come from the Realtime tables below, which a client maps to `HubEvent`s itself.

## Messages

Routing, validation and the hop limit are the LAN hub's (`hub-api.md`): `from` must be one of the caller's own addresses (`<user>/<agent>`,
not a broadcast) → else 422 `from_mismatch`; the delivered copy has `hops + 1`, so `hops + 1 > HOP_LIMIT` is stored as dropped and refused
with `hop_limit`; a duplicate `id` answers the same way as the first time and is not routed again.
Recipients: `user/agent` and `user/*` → that user; `*` → every active person (owner included) except the sender. A target user who isn't
an active person is refused with `unknown_target` (and not stored).

### `POST /api/messages`
Two body forms:
- daemon: `{ envelope: Envelope }` (built by the daemon, as for the LAN hub);
- browser: `{ to, type, body, reply_to?, from_agent? }`; the API fills `id` (uuid), `from = <user>/<from_agent ?? "human">`, `hops: 0`, `timestamp`.

200 `{ id, accepted: true }`. 422 `{ id, rejected: true, reason }` with reason `hop_limit | bad_address | bad_envelope | from_mismatch | unknown_target`.
Storing the message inserts one `deliveries` row per recipient user; that row is what the recipient's daemon receives over Realtime.

### `GET /api/messages?address=&with=&limit=50&before=<iso>`
`{ messages: StoredMessage[] }`, newest first. Always narrowed to messages from or to the caller's user plus broadcasts to `*`
(same rule as `hub-api.md` "What each user can read"), on top of the `address` / `with` filters. `GET /api/messages/:id` → `StoredMessage`,
404 if missing or not the caller's to see.

### Deliveries (incoming messages for a daemon)
Table `deliveries`, one row per (message, recipient user): `{ seq, message_id, username, hops, envelope, acked, acked_at, created_at }`,
where `envelope` is the delivered copy (hops already + 1) and `seq` is a global bigserial.
- **Live:** Realtime `postgres_changes`, event `INSERT`, schema `public`, table `deliveries`, filter `username=eq.<me>`. Payload `new` = the row.
- **Resume:** `GET /api/deliveries?since_seq=N&limit=500` → `{ deliveries: [{ seq, envelope }], last_seq }`: every *unacked* delivery for the
  caller with `seq > N` (N defaults to 0), oldest first. `last_seq` = the highest seq returned (or N). Call it on every (re)connect.
- **Ack:** `POST /api/deliveries/ack { ids: string[] }` (message ids, up to 500) → `{ acked: number }`. Marks the caller's rows acked; when a
  message has no unacked rows left its state becomes `delivered`.

## Sessions and presence

| Method | Path | Body | Result |
|---|---|---|---|
| PUT | `/api/sessions/:agent` | `{ kind, status, task }` | 200 `Session`. Upsert of `<user>/<agent>`; the row changes only if kind/status/task changed (no Realtime noise) |
| DELETE | `/api/sessions/:agent` | | 204 |
| POST | `/api/heartbeat` | `{ agents: string[] }` | 204. Sets the caller's `people.last_seen`, and `sessions.last_heartbeat` for those agents when it is over 20s old (so a heartbeat shows up on the `sessions` Realtime feed at most once per session per ~20s) |
| GET | `/api/sessions` | | `{ users: UserPresence[] }` for every active person. `connected` = `last_seen` within 30s; a session whose `last_heartbeat` is older than 30s is reported `status: "offline"` |

Daemons heartbeat every `HEARTBEAT_INTERVAL_MS` (10s). Live "who is online" for clients is Realtime **Presence** on channel `presence`
(private): a daemon tracks key `<user>`, payload `{ user, kind: "daemon", at }`; a browser tracks key `<user>:web`, payload `{ user, kind: "web", at }`.
Session changes arrive as `postgres_changes` on table `sessions` (all events); a client treats a session as offline when its user has
no `daemon` entry in `presence`.

## Shared context

Same semantics as the LAN hub. `GET /api/context?q=` → `{ entries }`; `GET /api/context/:key` → `ContextEntry` | 404;
`PUT /api/context/:key` body `{ title, kind, body, base_version?, agent? }` → 200 `ContextEntry` | 409 `{error:"conflict", current}` | 400;
the API sets `author = <user>/<agent ?? "orchestrator">`. `DELETE /api/context/:key` → 204 | 404.
A write also inserts a `context_update` delivery to every active person (`from` = author, `to` = `<user>/*`,
`body = { text: "<title> updated", context_key }`), exactly like the LAN hub. Live: `postgres_changes` on table `context`.

## Screens (live terminals; never stored)

- Publishing: `POST /api/screens { screen: ScreenUpdate }` (agent must be one of the caller's sessions; text ≤ `SCREEN_MAX_BYTES`;
  cols/rows 1..2000) → 204. The API broadcasts it on channel `screens`, event `screen`, payload `{ address, screen, at }`. Not written anywhere.
  The daemon throttles to 1 update per pane per 3s and publishes only while someone is watching (below). The API also refuses more than
  2 updates per pane per 3s that reach the same server instance (429), best effort.
- Watching: a viewer joins channel `screens` (private) and tracks Presence key `<user>:<random>`, payload `{ user, watching: "*" | string[] }`
  (`string[]` = addresses or `user/*`). A daemon publishes a pane when any presence entry other than its own watches `*`, `<me>/*` or that address.
- `POST /api/screens/gone { agent }` → 204: broadcasts event `screen.gone`, payload `{ address }`.

## Typing into your own panes (website → your daemon → bridge)

Only for the caller's own team. Rules are `input.md`'s (yes/no prompt open → skipped, log length never text).
- `POST /api/panes/input { agents: string[], text, submit? }` (agents ⊆ `orchestrator`, `worker-1`..`worker-4`; text 1..4000 chars).
  Cookie requests need the same-origin `Origin` and the header `X-Agentlink-Input: 1`. → 202 `{ id }`.
  503 `{error:"no_daemon"}` when the caller's daemon hasn't heartbeated in the last 30s. The API stores `{ id, username, agents, chars, state: "pending" }`
  (never the text) in `pane_inputs`, then broadcasts on channel **`input:<user>`** (private), event `input`, payload
  `{ id, user, agents, text, submit, at, sig }`. Nobody but the server can send on `input:*` channels, and only `<user>` can join `input:<user>`.
- `sig` (defense in depth, in case a channel policy is ever wrong) = hex HMAC-SHA256(key = `sha256(code)` hex of the caller's own access code,
  msg = `"agentlink-input-v1\n" + user + "\n" + id + "\n" + at + "\n" + agents.join(",") + "\n" + (submit ? "1" : "0") + "\n" + text`).
  For the owner the code is `AGENTLINK_MASTER_CODE`. The key is never sent to or readable by any client. The daemon (which knows its own
  code) refuses a bad sig, `user` ≠ itself, `|now - at| > 60s`, a repeated `id`, agents outside the five, or text outside 1..4000 chars.
- The daemon hands it to the bridge exactly like a local `POST /v1/panes/input`, then reports:
  `POST /api/panes/input/:id/result { state?: "done" | "failed", results: { [agent]: "sent" | "skipped: prompt_open" | "skipped: no_pane" | "failed: <why>" } }` → 204
  (state defaults to `done`).
- `GET /api/panes/input/:id` → `{ id, state: "pending" | "done" | "failed", results? }` (own inputs only). An input still pending after
  60s reads as `failed` with `results` = `failed: no_daemon` for each agent.

## People (owner only)

Owner = a session whose user is `AGENTLINK_OWNER` (logged in with the master code). Others → 403 `{error:"owner_only"}`.

| Method | Path | Result |
|---|---|---|
| GET | `/api/admin/people` | `{ owner, people: [{ user, epoch, created_at, invited_at, revoked_at, last_seen, connected }] }` (no codes, no hashes) |
| POST | `/api/admin/people` | `{ user }` → `{ user, code, epoch, reinvited }`. The code is shown only here. 400 bad name or the owner |
| POST | `/api/admin/people/:user/revoke` | `{ ok: true, user }` \| 404. Sets `revoked_at`, then broadcasts on channel **`user:<user>`** event `revoked`, payload `{ user, at }` |

On `revoked` (or any 401 `{error:"revoked"}`) a daemon goes offline and stops retrying until restarted with a new code; a browser signs out.
Re-inviting a connected person also broadcasts `revoked` to their old clients (their epoch no longer matches).

## Your calls (claude4 decisions waiting on the team's owner)

Types and validation: `contracts/calls.ts`. Each person's daemon (`daemon/src/calls.ts`) reads the claude4 inbox in
`~/.claude4/$C4_SESSION`, the same files the boss circle reads: `requests/<id>.json` with `needsBryant: true` and no
`<id>.bryant`, and `questions/<id>.json` with no `<id>.answer`. Rows live in `public.calls`, keyed by
`(username, id)`. They are service-role only and not in Realtime, so the page polls. Every route answers for the
caller's own calls only, the owner included.

- `PUT /api/calls/sync` (daemon) `{ calls: CallUpload[] }` → `{ answers: [{id, choice, note}] }`. The body is the full
  pending set, at most 50. Rows not listed are deleted (answered on the boss circle, or delivered). The reply has the
  listed calls answered on the site. A call without a plain-English `summary` is refused with 400 `bad_call`.
- `GET /api/calls` → `{ calls: Call[] }`, oldest first. `state` is `pending`, or `answering` once answered on the
  site and until the daemon delivers it.
- `POST /api/calls/:id/answer` `{ choice: "yes"|"no", note? }`, or `{ note }` alone for a question (free text).
  Cookie writes need the site's origin. 200 `{ call }`, 400 `bad_answer`, 404 `not_found`, 409 `already_answered`.

The daemon syncs within 1.5s of an inbox change, every 3s while calls wait, and every 60s otherwise. It delivers a
site answer with `c4 decide <id> approve|deny [note]` or `c4 answer <id> "<Yes|No — note | text>"`, run with
`C4_SESSION` set and `TMUX_PANE=""`, the way the boss circle's `/api/decide` and `/api/answer` do.

## Realtime summary

| Channel / table | Kind | Who reads | Payload |
|---|---|---|---|
| table `deliveries` | postgres_changes INSERT, filter `username=eq.<me>` | own rows | the row |
| table `messages` | postgres_changes INSERT/UPDATE | rows from/to me or `*` | the row (`from_addr`, `to_addr`, …; see the migration) |
| table `sessions` | postgres_changes * | every active person | the row |
| table `context` | postgres_changes * | every active person | the row |
| `presence` | Presence | every active person | `{ user, kind: "daemon" \| "web", at }` |
| `screens` | broadcast `screen` / `screen.gone` + Presence | every active person | see Screens |
| `input:<user>` | broadcast `input` (server only) | `<user>` only | `{ id, user, agents, text, submit, at, sig }` |
| `user:<user>` | broadcast `revoked` (server only) | `<user>` only | `{ user, at }` |

All broadcast/presence channels are private (`config: { private: true }`); join authorization is RLS on `realtime.messages`.

Client setup (verified against local Supabase with `@supabase/supabase-js` 2.117.2). Both parts are required:
```ts
let jwt = login.realtime.jwt;
const sb = createClient(login.realtime.url, login.realtime.anon_key, { accessToken: async () => jwt });
await sb.realtime.setAuth(jwt);            // BEFORE the first channel.subscribe()
// on refresh: jwt = refreshed.realtime.jwt; await sb.realtime.setAuth(jwt);
```
Without `accessToken`, supabase-js's own auth module resets Realtime to the anon key a moment later; without the awaited
`setAuth`, the first joins go out with the anon key. Either way the join runs as `anon`: postgres_changes with a filter fails
("invalid column for filter") and private topics are refused. PostgREST selects with this client use the JWT too.

Row → `HubEvent` mapping for clients: `messages` INSERT → `message.accepted` (state `dropped` → `message.dropped`); `messages` UPDATE to
state `delivered` → `message.delivered { id, to: to_addr, at: delivered_at }`; `sessions` INSERT/UPDATE → `session.updated`, DELETE →
`session.removed { address }`; `context` INSERT/UPDATE → `context.updated`, DELETE → `context.deleted`. A `messages` row converts to
`StoredMessage` as `{ id, from: from_addr, to: to_addr, reply_to, hops, type, body, timestamp, state, accepted_at, delivered_at, drop_reason }`
(`body` is jsonb: a string body is stored as a JSON string). A `sessions` row converts to `Session` by dropping `last_heartbeat` and
renaming `username` → `user`. `user.connected/disconnected` come from `presence` joins/leaves of `kind: "daemon"` entries.
With RLS on, a DELETE event's `old` carries only the primary key (`address` for sessions, `key` for context), which is all the mapping needs.

## Database (cloud/supabase/migrations)

Tables: `settings(k, v)`, `people(username pk, code_hash unique, epoch, is_owner, created_at, invited_at, revoked_at, last_seen)`,
`messages(id pk, from_addr, to_addr, from_user, to_user, reply_to, hops, type, body jsonb, timestamp, state, accepted_at, delivered_at, drop_reason)`,
`deliveries(seq, message_id, username, hops, envelope jsonb, acked, acked_at, created_at; pk (message_id, username))`,
`sessions(address pk, username, agent, kind, status, task, last_activity, last_heartbeat)`, `context(key pk, …)`,
`pane_inputs(id, username, agents, chars, state, results, created_at)`, `login_failures(ip, at)`.
RLS is on for all of them. `authenticated` may only SELECT, through `app_active()` (the JWT's `app_user` is an active person whose epoch
matches the JWT's `epoch`): messages from/to them or `*`; their own deliveries and pane_inputs; all sessions and context. `people`,
`settings` and `login_failures` have no client policies. Writes are service-role only (the API).
