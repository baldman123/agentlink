import { hostname } from "node:os";
import { DEFAULT_PORTS, PROTOCOL_VERSION } from "../../contracts/index.ts";
import { Hub } from "./hub.ts";
import { logInfo } from "./log.ts";
import { Advertiser, installMdnsCrashGuard } from "./mdns.ts";

// mDNS is best-effort; a multicast send failure must never take the hub down.
installMdnsCrashGuard();

const token = process.env.AGENTLINK_TOKEN;
if (!token) {
  console.error("agentlink hub: AGENTLINK_TOKEN is required");
  process.exit(1);
}

const host = hostname().replace(/\.local$/, "");
const hub = new Hub({
  port: Number(process.env.AGENTLINK_HUB_PORT ?? DEFAULT_PORTS.hub),
  host: process.env.AGENTLINK_HUB_HOST ?? "0.0.0.0",
  token,
  dbPath: process.env.AGENTLINK_HUB_DB ?? "./data/hub.sqlite",
  hubName: process.env.AGENTLINK_HUB_NAME ?? "", // filled in below once the port is known
});

const port = await hub.listen();
// One name everywhere: mDNS instance, TXT name, welcome/health hub_name.
// The port suffix keeps two hubs on one machine from colliding.
hub.opts.hubName ||= `agentlink-hub-${host}-${port}`;
logInfo("hub.started", { port, hub_id: hub.hubId, hub_name: hub.opts.hubName, protocol: PROTOCOL_VERSION });

let advertiser: Advertiser | null = null;
if (process.env.AGENTLINK_MDNS !== "0") {
  advertiser = new Advertiser({ name: hub.opts.hubName, port, hubId: hub.hubId });
  advertiser.start();
}

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  logInfo("hub.stopping", { signal: sig });
  await advertiser?.stop();
  await hub.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
