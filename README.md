# agentlink

agentlink links claude4 teams on different Macs. Each team (five Claude Code sessions in tmux, coordinated with the `c4` command) sees the others' status and can send them tasks, through a hub that is either a website or one laptop on the local network.

To set it up, open Claude Code in this folder and say "set this up for me". It follows [CLAUDE.md](CLAUDE.md). To do it by hand, read [SETUP.md](SETUP.md).

The repository is private. The owner has to add you as a collaborator before `git clone` works, and until pull request #1 is merged the code is on the `feat/cloud-calls-usage` branch:

```sh
git clone -b feat/cloud-calls-usage https://github.com/baldman123/agentlink.git ~/agentlink
```

## Layout

| Folder | What it is |
|---|---|
| `hub/` | LAN hub: one laptop runs it, everyone's daemon connects to it |
| `cloud/` | the website version of the hub (Next.js on Vercel, Supabase) |
| `daemon/` | runs on every Mac; links the local team to the hub |
| `bridge/` | pastes incoming messages into the claude4 panes and reports pane state |
| `ui/` | the local web app, `http://127.0.0.1:7780` |
| `orchestrator/` | the `bin/agentlink` command the boss uses to reply |
| `contracts/` | the protocols between the parts |
| `scripts/` | `team-up.sh`, `team-down.sh`, `autostart.sh` and the end-to-end tests |
| `tools/claude4/` | claude4 and c4, with an installer |
