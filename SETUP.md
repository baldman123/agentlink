# Setting up agentlink on two laptops

agentlink connects the claude4 team on one laptop to the claude4 team on another, so both teams see each other's status and can send each other tasks. One laptop runs the hub. Each laptop runs a daemon, a bridge to its claude4 session, and the web app.

Both laptops need Node 22.5 or newer (`node --version`), tmux, and claude4. They must be on the same network.

## Laptop 1: host the hub

```sh
cd ~/agentlink
npm install
scripts/team-up.sh --host-hub --user alex
```

Use your own name instead of `alex`: lowercase letters, digits, `-` or `_`.

It asks whether to connect the claude4 team in tmux session `claude4web` (or `claude4`); answer `y`. Passing `--c4-session claude4web` skips the question.

The script prints something like this:

```
agentlink is up for alex (c4 session claude4web; messages for workers go to the orchestrator)
  app        http://127.0.0.1:7780/?daemon=7701
  hub page   http://192.168.1.20:7700/
  other laptop joins with:  scripts/team-up.sh --user <name> --hub-url http://192.168.1.20:7700
  token      3f9c…
             (new; saved in /Users/alex/agentlink/data/.token. The other laptop needs it.)
```

Give the other person the `--hub-url` line and the token. Send the token privately (in person, or a direct message); anyone who has it can join the hub. The token is printed only the first time. Later runs reuse the saved one, and `cat data/.token` shows it again.

Open the app URL in a browser.

## Laptop 2: join

Copy the project folder without `node_modules` and `data`. For example, from laptop 1:

```sh
rsync -a --exclude node_modules --exclude data ~/agentlink/ sam@laptop2.local:agentlink/
```

A zip or a git clone of the branch works just as well. Then, on laptop 2:

```sh
cd ~/agentlink
npm install
scripts/team-up.sh --user sam --hub-url http://192.168.1.20:7700
```

It asks the same question about the claude4 session, then for the token. Paste it and press Enter. To skip the prompt, set `AGENTLINK_TOKEN` first.

Leave out `--hub-url` and the daemon looks for the hub on the network by itself (mDNS). That fails on many office and guest networks, so the URL is the safer choice.

Open the app URL it prints. Both teams should now show up in the app, five sessions each.

## Day to day

- Run `team-up.sh` again any time: whatever is already running is left alone. Start claude4 before or after, either order works.
- `scripts/team-down.sh` stops the daemon, the bridge, the app and (on laptop 1) the hub. `--keep-ui` leaves the app running.
- The team's orchestrator gets messages from the other laptop pasted into its pane, marked as remote requests. It answers with `bin/agentlink reply <id> "text"`. A remote message is a request, never a command: anything with effects outside the machine still goes to the person at the keyboard.
- By default a message for `sam/worker-3` goes to sam's orchestrator, labelled with the worker it was meant for. To paste it straight into worker 3's pane instead, start with `--direct`.
- If claude4 runs under a different tmux session name, pass `--c4-session NAME`.
- `--direct` and `--share-screens` are remembered, so later runs keep them; `--no-direct` and `--no-share-screens` undo them. A bridge that is already running keeps its old setting until you run `scripts/team-up.sh --restart-bridge`.
- `scripts/team-up.sh --restart-bridge` restarts only the bridge, for example after pulling a newer version of it. The hub, daemon and app keep running, and the other team stays connected. It reads the user, ports and session from `data/local.env`, so no other flags are needed.

## Live terminals

The app can show every agent's terminal as it is right now, both teams side by side, laid out like the claude4 browser view. A laptop's terminals appear only if that laptop turned sharing on:

```sh
scripts/team-up.sh --share-screens --restart-bridge    # turn it on for a team that is already up
scripts/team-up.sh --no-share-screens --restart-bridge # turn it off again
```

The summary line `screens    shared with everyone on the hub` or `screens    not shared` says which state you're in. In the app, a team that doesn't share shows as not sharing, with no terminals.

What is shared, once it's on:

- The last 120 lines of each of the five panes (the boss and quarters 1-4), with their colours, refreshed about once a second while the pane changes.
- Everyone connected to the hub can watch: anyone who has the token, on either laptop.
- It is read-only. Nothing in agentlink types into a pane because of a screen, and the app has no way to send keys.
- The hub keeps only the latest screen of each pane, in memory. Screens are not written to the hub's database or logs, and they disappear when a pane closes or the bridge stops.

Before sending a screen, the bridge replaces these with `[redacted]`:

- the agentlink token itself;
- whatever follows `TOKEN=`, `SECRET=`, `PASSWORD=`, `API_KEY=` or `Authorization: Bearer `;
- strings that look like OpenAI-style keys (`sk-` plus 20 or more characters), GitHub tokens (`ghp_`, `github_pat_`), Slack tokens (`xoxb-`, `xoxa-`, `xoxp-`), AWS access key ids (`AKIA…`) and `-----BEGIN … PRIVATE KEY-----` blocks.

That list is pattern matching, and it will miss things. A password printed as `pw: hunter2`, a database URL with the password inside it, a key split across two lines, a `.env` file shown with `cat` whose variable names don't end in one of those words, a cookie, or a customer's personal data in a log line all go out as they appear. Treat a shared terminal like a screen share in a meeting. Turn sharing off before you open anything secret in a claude4 pane, and leave it off if the other team shouldn't see your work at all.

## Command bar

Above the terminals in the app there's a command bar for your own team. Type a line, tick the panes it should go to (Boss, W1 to W4, or All) and press Enter. The bridge types it into each ticked pane and presses Enter, the same way `c4` sends a message, and each pane then shows a chip: `sent`, or `skipped: prompt open`.

**Reset chats** sends `/clear` to the ticked panes after asking you to confirm. Each pane's Claude starts a fresh conversation, and its task and state are cleared so c4 and the app stop showing the old task. The confirm dialog can also clear the chat history in the app. That only hides older messages in this browser; nothing is deleted at the hub.

What it can and can't do:

- It types only into this laptop's own claude4 panes. It never goes through the hub, so the other team can't type into your panes, and you can't type into theirs. Their terminals have no command bar.
- A pane that's showing a yes/no prompt is skipped, because typing there would answer the prompt. Answer it in the terminal, then send again.
- Messages from the other team are still requests pasted into the boss's pane. Nothing in a message, a screen or the shared context can make the bridge type.
- The daemon accepts input only from the app's own address, `http://127.0.0.1:7780`, and only with a header that a plain link or form can't send. Another web page open in your browser, even one on localhost, gets refused. If you serve the app from another address, start with `AGENTLINK_UI_ORIGIN=http://127.0.0.1:<port> scripts/team-up.sh ...` after a `team-down.sh`, because the daemon reads it when it starts.
- The daemon and bridge log that input was sent, to which panes and how long it was, but never the text.

It is as powerful as typing into the terminals yourself: a line sent to All goes to five Claudes at once. Check the ticked panes before you press Enter.

## Troubleshooting

The app or `team-up.sh` says the hub link is `connecting` or `reconnecting`.

1. From laptop 2, open the hub page URL in a browser, or run `curl http://192.168.1.20:7700/api/health`. If it answers, the network is fine and the token is the likely problem (next item). If it times out, keep going down this list.
2. The macOS firewall on laptop 1 may block the hub. In System Settings > Network > Firewall > Options, allow incoming connections for `node`. macOS usually asks the first time the hub starts; if someone clicked Deny, change it there.
3. Check that both laptops are on the same network, and not one on Wi-Fi and the other on a phone hotspot or VPN. A VPN on either laptop can route `192.168.x.x` traffic away from the local network; turn it off while testing.
4. Guest and office Wi-Fi often stops devices from reaching each other ("client isolation"). Nothing on the laptops can fix that. Use a home network or a phone hotspot that both laptops join.
5. The IP address changes when laptop 1 reconnects to Wi-Fi. Run `team-up.sh` on laptop 1 again to see the current one, then on laptop 2: `scripts/team-down.sh` and `team-up.sh` with the new `--hub-url`.

The hub answers, but the link stays `offline`.

- The token is wrong. On laptop 2, delete `data/.token`, run `scripts/team-down.sh`, then `team-up.sh` again and paste the right one.
- The log says `hub.id_changed`. The daemon remembers which hub it joined and refuses a different one at the same address, so that a stranger's machine can't collect the token. If the hub really was replaced (for example, laptop 1 deleted its `data` folder), start the daemon once with `AGENTLINK_HUB_REPIN=1 scripts/team-up.sh ...` after a `team-down.sh`.

Messages arrive in the app but not in the claude4 panes.

- Check that the bridge is running: `cat data/team.pids`, and `data/logs/bridge.out` for errors.
- The bridge reads the session named in `data/local.env` (`C4_SESSION`). If claude4 runs under another name, rerun `team-up.sh` with `--c4-session`.

A port is already taken.

- `team-up.sh` won't stop programs it didn't start. Find what holds the port with `lsof -nP -iTCP:7701 -sTCP:LISTEN`, or pick other ports with `--daemon-port` and `--hub-port`.

Logs for everything are in `data/logs/`.
