import { hostname } from "node:os";
import { Bonjour } from "bonjour-service";
import { DEFAULT_PORTS, MDNS_SERVICE_TYPE, PROTOCOL_VERSION } from "../../contracts/index.ts";
import { Hub } from "./hub.ts";
import { logInfo } from "./log.ts";

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

let bonjour: Bonjour | null = null;
if (process.env.AGENTLINK_MDNS !== "0") {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: hub.opts.hubName,
      type: MDNS_SERVICE_TYPE,
      port,
      txt: { v: String(PROTOCOL_VERSION), hub_id: hub.hubId, name: hub.opts.hubName },
    });
    logInfo("mdns.published", { type: `_${MDNS_SERVICE_TYPE}._tcp`, name: hub.opts.hubName, port });
  } catch (err) {
    logInfo("mdns.failed", { error: String(err) });
  }
}

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  logInfo("hub.stopping", { signal: sig });
  if (bonjour) {
    await new Promise<void>((r) => bonjour!.unpublishAll(() => r()));
    bonjour.destroy();
  }
  await hub.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
