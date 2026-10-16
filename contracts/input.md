# Local terminal input (v1)

A command bar in the UI types into this laptop's own claude4 panes: one line of text into every checked pane, or
`/clear` into all of them ("Reset chats"). It is the local person at the keyboard, so it is trusted. It never crosses
the hub: no remote user, message, or screen can reach this channel, and the UI only offers it for its own user's agents.

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

## UI

The bar sits in the Terminals view, above the panes, and appears only for the signed-in user's own team:
- a text field;
- a checkbox per pane (Boss, W1–W4) plus **All**;
- **Send** (Enter);
- **Reset chats**, which sends `/clear` to the checked panes after a confirm dialog naming them.

Then show a per-pane result chip (sent / skipped: prompt open).

Reset chats also offers "clear the UI chat history too". That's a local-only view reset: it hides messages older than now in this browser. Nothing is deleted at the hub.
