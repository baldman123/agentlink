// agentlink ↔ claude4 bridge (contracts/bridge.md). One per laptop, next to the daemon.
import { loadConfig } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { Inbound } from "./inbound.ts";
import { initLog, log } from "./log.ts";
import { Store } from "./store.ts";
import { StatusSync } from "./sync.ts";
import { Tmux } from "./tmux.ts";

const cfg = loadConfig();
initLog(cfg.logPath, cfg.user);

const store = new Store(cfg.dbPath);
const tmux = new Tmux(cfg.tmuxSocket);
const daemon = new Daemon(cfg.daemonUrl);
const sync = new StatusSync(cfg, tmux, daemon, store);
const inbound = new Inbound(cfg, tmux, daemon, store, () => void sync.tick());

log("bridge.started", {
  daemon: cfg.daemonUrl,
  c4_session: cfg.session,
  state_dir: cfg.stateDir,
  tmux_socket: cfg.tmuxSocket,
  direct: cfg.direct,
  db: cfg.dbPath,
  first_run: store.firstRun,
});

sync.start();
inbound.start();

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log("bridge.stopping", { signal: sig });
  inbound.stop();
  sync.stop();
  await Promise.race([sync.markOffline(), new Promise((r) => setTimeout(r, 2_000))]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
