# c4 ↔ agentlink bridge (v1)

Joins a claude4 team (the boss plus quarters 1-4 in tmux) to agentlink, so that two laptops' teams (10 agents) can see each
other and work together. One bridge per laptop, running next to that laptop's daemon.

## Identity

| c4 slot | agentlink address | kind |
|---|---|---|
| 0, or whichever slot has `@role orchestrator` | `<user>/orchestrator` | orchestrator |
| N (1-4), worker | `<user>/worker-N` | worker |
| the person at the keyboard | `<user>/human` | human (the UI's existing sender) |

## Config (env)

| Var | Meaning |
|---|---|
| `AGENTLINK_USER` | required, same as the daemon's |
| `AGENTLINK_DAEMON_PORT` | default 7701 |
| `C4_SESSION` | default `claude4`; state is read from `~/.claude4/$C4_SESSION/panes` and tmux pane options |
| `AGENTLINK_BRIDGE_DIRECT` | `1` = a message addressed to `<user>/worker-N` is pasted into that worker's pane. Default `0`: it goes to the orchestrator, labelled with the worker it was meant for |
| `AGENTLINK_BRIDGE_DB` | default `./data/bridge-<user>.json` (which inbox ids were already pasted) |

## Status sync (every 3s, and when something changes)

For every slot, `PUT /v1/sessions/<agent>` with `{kind, status, task}`:
- `task` = the pane's `@task` option ("" when unset; the orchestrator's is "coordinating N workers" or "").
- `status`: the Claude in the pane is busy (its screen shows `esc to interrupt`) → `working`; `@state` `blocked` → `error`;
  `asking`, or a yes/no prompt on screen → `waiting`; otherwise `idle`. A slot that disappears → `DELETE`.
Only send a PUT when status or task changed, plus every 20s anyway (the daemon heartbeats; the PUT keeps `last_activity` fresh).

## Inbound (daemon SSE `GET /v1/inbox/stream` → tmux)

Paste each new inbox item once (dedupe by id; survives restarts), into the orchestrator pane unless DIRECT applies.
Skip `context_update` and `status` items (they show in the UI; the orchestrator reads context with the CLI when it needs to).
Paste exactly like `c4 send` does: wait while the pane shows a yes/no prompt, bracketed paste, then Enter.

Text pasted (the body uses the orchestrator package's trust formatter, so remote bodies arrive fenced with a nonce):

```
[agentlink <type> from <from> · id <id8>]  (for: <to>)        ← "(for: …)" only when not addressed to the orchestrator
<REMOTE REQUEST banner + fenced body, or plain body for a same-user sender>
Reply:   agentlink reply <id8> "<text>"     Decline: agentlink decline <id8> "<why>"
```

A remote message is a REQUEST. The orchestrator decides it like any request: it does safe work through its own team
(`c4 assign`), passes anything with effects outside the machine to Bryant (`c4 ask-bryant`), and answers with `agentlink reply`.
The bridge also appends one line to `~/.claude4/$C4_SESSION/board.md`: `- HH:MM **agentlink ← <from>** <type>: <first 60 chars>`.

## Outbound

The team uses the CLI at `~/agentlink/bin/agentlink` (a shell wrapper; no install). It reads `~/agentlink/data/local.env`
(`AGENTLINK_USER`, `AGENTLINK_DAEMON_PORT`), and the sender is `--from <agent>`, or else `AGENTLINK_AGENT`, or else `orchestrator`.
`agentlink reply <id-or-prefix> "<text>"` sends a `result` to the original sender with `reply_to` set (hops per the existing rules)
and marks the item handled.
