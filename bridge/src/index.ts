// agentlink ↔ claude4 bridge (contracts/bridge.md). One per laptop, next to the daemon.
import { loadConfig, loadToken } from "./config.ts";
import { Daemon } from "./daemon.ts";
import { AnswerWatch } from "./answers.ts";
import { Inbound } from "./inbound.ts";
import { PaneInput } from "./input.ts";
import { initLog, log } from "./log.ts";
import { ScreenShare } from "./screens.ts";
import { Store } from "./store.ts";
import { StatusSync } from "./sync.ts";
import { Tmux } from "./tmux.ts";

const cfg = loadConfig();
initLog(cfg.logPath, cfg.user);

const store = new Store(cfg.dbPath);
const tmux = new Tmux(cfg.tmuxSocket);
const daemon = new Daemon(cfg.daemonUrl);
const sync = new StatusSync(cfg, tmux, daemon, store);
// UI messages whose answer never came back with `agentlink reply` (contracts/bridge.md, "Answers to the UI").
const answers = cfg.answerFallback ? new AnswerWatch(cfg, tmux, daemon, loadToken()) : null;
const inbound = new Inbound(cfg, tmux, daemon, store, () => void sync.tick(), answers ? (item, slot) => answers.track(item, slot) : undefined);

log("bridge.started", {
  daemon: cfg.daemonUrl,
  c4_session: cfg.session,
  state_dir: cfg.stateDir,
  tmux_socket: cfg.tmuxSocket,
  direct: cfg.direct,
  share_screens: cfg.shareScreens,
  answer_fallback_ms: cfg.answerFallback ? cfg.answerWaitMs : null,
  db: cfg.dbPath,
  first_run: store.firstRun,
});

sync.start();
inbound.start();
answers?.start();

// The local UI's command bar (contracts/input.md); the daemon only accepts it from the local UI origin.
const input = new PaneInput(cfg, tmux, daemon, () => void sync.tick());
input.start();

// Opt-in only (contracts/screens.md). Without AGENTLINK_SHARE_SCREENS=1 no screen ever leaves this laptop.
const screens = cfg.shareScreens ? new ScreenShare(cfg, tmux, daemon, () => sync.team, loadToken()) : null;
screens?.start();

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log("bridge.stopping", { signal: sig });
  inbound.stop();
  answers?.stop();
  input.stop();
  sync.stop();
  await Promise.race([screens?.stop(), new Promise((r) => setTimeout(r, 1_000))]);
  await Promise.race([sync.markOffline(), new Promise((r) => setTimeout(r, 2_000))]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
