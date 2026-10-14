import { loadConfig } from "./config.ts";
import { Discovery } from "./discovery.ts";
import { createServer } from "./http.ts";
import { HubLink } from "./hublink.ts";
import { initLog, log } from "./log.ts";
import { Store } from "./store.ts";

const cfg = loadConfig();
initLog(cfg.logPath, cfg.user);

const store = new Store(cfg.dbPath, cfg.user);
const discovery = new Discovery(cfg.discovery, cfg.hubUrl, cfg.hubName);
const hub = new HubLink(cfg, store, discovery);
const api = createServer(cfg, store, hub);

try {
  await api.listen();
} catch (err) {
  log("daemon.listen_failed", { port: cfg.port, detail: String(err) });
  process.exit(1);
}
log("daemon.started", {
  port: cfg.port,
  api: `http://127.0.0.1:${cfg.port}`,
  db: cfg.dbPath,
  discovery: cfg.discovery,
  manual_hub: cfg.hubUrl,
  outbox_depth: store.outboxDepth(),
});

discovery.start();
hub.start();

let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("daemon.stopping", { signal: sig });
  hub.stop();
  api.close();
  discovery.stop();
  store.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
