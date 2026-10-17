import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CallRelay, c4Runner } from "./calls.ts";
import { CloudLink } from "./cloudlink.ts";
import { loadConfig } from "./config.ts";
import { Discovery } from "./discovery.ts";
import { createServer } from "./http.ts";
import { HubLink } from "./hublink.ts";
import type { DaemonHubLink } from "./link.ts";
import { initLog, log } from "./log.ts";
import { Store } from "./store.ts";
import { UsageReporter } from "./usage.ts";

const cfg = loadConfig();
initLog(cfg.logPath, cfg.user);

const store = new Store(cfg.dbPath, cfg.user);
// cloud: the hub is the website at AGENTLINK_HUB_URL; no mDNS, no subnet scan, no hub_id pin
const discovery = cfg.hubMode === "lan" ? new Discovery(cfg.discovery, cfg.hubUrl, cfg.hubName) : null;
const hub: DaemonHubLink = discovery ? new HubLink(cfg, store, discovery) : new CloudLink(cfg, store);
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
  hub_mode: cfg.hubMode,
  discovery: discovery ? cfg.discovery : null,
  manual_hub: cfg.hubUrl,
  outbox_depth: store.outboxDepth(),
});

discovery?.start();
hub.start();
// Claude plan usage for the website's meters (contracts/usage.ts); the LAN hub has no usage route
const usage = cfg.hubMode === "cloud" && process.env.AGENTLINK_USAGE !== "0" ? new UsageReporter(hub) : null;
usage?.start();
// "Your calls" (contracts/calls.ts): the claude4 calls waiting on this person, answerable on the website
const c4Session = process.env.C4_SESSION || "claude4";
const calls = cfg.hubMode === "cloud" && process.env.AGENTLINK_CALLS !== "0"
  ? new CallRelay(hub, process.env.C4_STATE_DIR || join(homedir(), ".claude4", c4Session), c4Runner(process.env.AGENTLINK_C4_BIN || (existsSync(join(homedir(), ".local/bin/c4")) ? join(homedir(), ".local/bin/c4") : "c4"), c4Session))
  : null;
calls?.start();

let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("daemon.stopping", { signal: sig });
  usage?.stop();
  calls?.stop();
  hub.stop();
  api.close();
  discovery?.stop();
  store.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
