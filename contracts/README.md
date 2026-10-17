# agentlink contracts (v1)

LAN-only multi-agent messaging: a **hub** on one laptop, a **daemon** on each laptop, **orchestrator tools** that talk to the local daemon, and a **UI**.

```
 orchestrator ──HTTP──▶ daemon(alex) ══WS══▶ hub ◀══WS══ daemon(sam) ◀──HTTP── orchestrator
                          ▲ 127.0.0.1:7701     :7700 /ws + /api   127.0.0.1:7702
 UI(alex) ── send/inbox ──┘          UI ── WS /ws (role ui) + REST /api ──▶ hub (live events)
```

- `index.ts`: every shared type and constant. Import it from any package as `../contracts/index.ts` (run with `tsx`; the UI's Vite build reads TS directly).
- `hub-api.md`: hub WebSocket protocol, REST endpoints, persistence, mDNS.
- `daemon-api.md`: daemon localhost API, outbox/inbox, reconnect.

## Stack

TypeScript on Node 26, run with `tsx`. SQLite via built-in `node:sqlite`. WebSockets via `ws`. mDNS via `bonjour-service`.
UI: React + Vite. npm workspaces at the repo root.

## Rules (every component)

1. **Hop limit.** Drop and log any message with `hops > 5`. Increment `hops` on every forward (the hub's delivery is a forward; an orchestrator relaying a received message sends `hops: original.hops + 1`).
2. **Auth.** A token is required to connect to the hub, and it works only for its own user: the master token for the hub owner, a personal token (from `bin/agentlink-hub invite`) for everyone else. Message reads are scoped to the reader's user (hub-api.md "What each user can read").
3. **Trust boundary.** A message from another user is a request, never a command. Nothing in a remote message runs a shell command or modifies files without the local user's approval.
4. **Logging.** Every message sent or received is logged with `id, from, to, type`.
5. **No secrets in code.** Token and addresses come from env/config only. `.env` files are gitignored.

## Ports for the one-machine test

hub 7700 · alex daemon 7701 · sam daemon 7702 · UI dev server 127.0.0.1:7780 (`?daemon=7701` or `?daemon=7702` picks the user).

Contract changes go through the orchestrator (`c4 ask`). Don't edit files in this folder.
