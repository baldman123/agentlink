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
