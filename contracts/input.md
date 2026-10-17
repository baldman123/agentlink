# Local terminal input (v1)

A command bar in the UI types into this laptop's own claude4 panes: one line of text into every checked pane, or
`/clear` into all of them ("Reset chats"). It is the local person at the keyboard, so it is trusted. It never crosses
the hub: no remote user, message, or screen can reach this channel, and the UI only offers it for its own user's agents.
The one exception is cloud mode, where the owner types into their own panes from the website, through signed frames only
(see "Cloud input" below).

## Flow

UI → `POST /v1/panes/input` (daemon, localhost) → daemon holds it in memory → bridge reads it from
`GET /v1/panes/input/stream` (SSE, localhost) → bridge types it into the panes → bridge reports the result →
`POST /v1/panes/input/:id/result` → the UI reads `GET /v1/panes/input/:id`.

### `POST /v1/panes/input`

Body: `{ agents: string[], text: string, submit?: boolean }`, where agents are local agent names (`orchestrator`, `worker-1`..`worker-4`).
`text` is 1..4000 characters, a single line or several (sent as one bracketed paste), and `submit` defaults to true (press Enter after).
Response: 202 `{ id }`. Errors: 400 for a bad body, 403 for the wrong origin or a missing header, 503 `{error:"no_bridge"}` when no bridge stream is connected.

Guards, on top of the daemon's usual localhost bind, Host check and CORS:
- The `Origin` header must equal `AGENTLINK_UI_ORIGIN` (default `http://127.0.0.1:7780`). Other localhost origins are refused,
  so another local web app can't type into the panes.
- The request needs the header `X-Agentlink-Input: 1`, which forces a CORS preflight.
- It is logged as `{event:"input.requested", id, agents, chars}`. The text itself is never logged.

### `GET /v1/panes/input/stream` (bridge only)

SSE, `event: input`, `data: { id, agents, text, submit }`. One bridge at a time: a newer connection replaces the older one.
Requests are kept for 60s while no bridge is connected, then dropped as `failed: no_bridge`.

### Bridge

For each agent, find its pane:
- A yes/no prompt on screen → don't type, result `skipped: prompt_open`. Typing would answer the prompt.
- Otherwise do what `c4`'s send() does: bracketed paste of `text`, then Enter if `submit`.
- When the text is exactly `/clear`, also set that pane's tmux options `@state idle` and `@task ""`, so c4 and the UI stop showing the old task.

Then `POST /v1/panes/input/:id/result` with `{ results: { [agent]: "sent" | "skipped: prompt_open" | "skipped: no_pane" | "failed: <why>" } }`.
Log `{event:"input.typed", id, agent, result}`, never the text.

### `GET /v1/panes/input/:id`

`{ id, state: "pending" | "done" | "failed", results? }`. Results are kept for 10 minutes.

## Cloud input (website → your own panes; `cloud-api.md` "Typing into your own panes")

In cloud mode the website is the owner's command bar too. The API sends the request as a broadcast on the private Realtime channel
`input:<user>` (event `input`, payload `{ id, user, agents, text, submit, at, sig }`), and the daemon's cloud link hands it to the bridge
through the same in-memory queue and SSE stream as a local `POST /v1/panes/input`. The bridge needs no change and can't tell them apart.
This is the only path from the hub side to the panes; the LAN hub link has none.

Before anything is typed, the daemon (`daemon/src/cloudinput.ts`) checks, and refuses with `input.cloud_refused {reason, id}`:
- `sig` = hex HMAC-SHA256(key = sha256 hex of this daemon's own access code, msg = `"agentlink-input-v1\n" + user + "\n" + id + "\n" + at
  + "\n" + agents.join(",") + "\n" + (submit ? "1" : "0") + "\n" + text`), compared in constant time → else `bad_sig`. Only the API (which
  stores that hash) and this daemon know the key, so a wrong channel policy alone can't let another person type here;
- `user` is this daemon's user → else `wrong_user`; `|now - at| ≤ 60s` → else `stale`; the `id` hasn't been seen in the last 10 minutes → else `replay`;
- agents are 1..5 distinct names from `orchestrator`, `worker-1`..`worker-4` → else `bad_agents`; text is 1..4000 characters → else `bad_text`.

An accepted frame is logged `input.cloud_accepted {id, local_id, agents, chars}` (never the text). No bridge connected → no typing, and
the result is reported at once as `failed: no_bridge` for each pane. Otherwise, when the bridge reports (or the request times out), the
daemon sends `POST /api/panes/input/:id/result { state: "done" | "failed", results }` with the same per-pane strings as above.

## UI

The bar sits in the Terminals view, above the panes, and appears only for the signed-in user's own team:
- a text field;
- a checkbox per pane (Boss, W1–W4) plus **All**;
- **Send** (Enter);
- **Reset chats**, which sends `/clear` to the checked panes after a confirm dialog naming them.

Then show a per-pane result chip (sent / skipped: prompt open).

Reset chats also offers "clear the UI chat history too". That's a local-only view reset: it hides messages older than now in this browser. Nothing is deleted at the hub.
