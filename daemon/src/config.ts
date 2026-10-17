import path from "node:path";
import { DEFAULT_PORTS } from "../../contracts/index.ts";

export interface Config {
  user: string;
  token: string; // LAN: the shared hub token. Cloud: this person's access code.
  hubUrl: string | null; // manual fallback, normalized to http://host:port (cloud: the site's origin)
  /** "cloud" when AGENTLINK_HUB_URL is https:// or AGENTLINK_HUB_MODE=cloud: the hub is the website (contracts/cloud-api.md). */
  hubMode: "lan" | "cloud";
  discovery: "mdns" | "manual";
  hubName: string | null; // when set, mDNS accepts only a hub whose TXT name or hub_id equals it
  repin: boolean; // AGENTLINK_HUB_REPIN=1: accept a hub whose hub_id differs from the pinned one, and re-pin
  port: number;
  dbPath: string;
  logPath: string;
  uiOrigin: string; // the only Origin allowed to POST /v1/panes/input (contracts/input.md)
  hubId: string | null; // AGENTLINK_HUB_ID: pinned from the start; the daemon connects to nothing else
  scan: boolean; // AGENTLINK_SCAN (default on): probe the local subnet for the pinned hub
  scanHosts: string[] | null; // AGENTLINK_SCAN_HOSTS (tests): "host" or "host:port" entries, replaces the subnet
}

const USER_RE = /^[a-z0-9_-]{1,32}$/;

function fail(msg: string): never {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "daemon", event: "config.error", detail: msg }));
  process.exit(1);
}

export function loadConfig(env = process.env): Config {
  const user = env.AGENTLINK_USER ?? "";
  if (!USER_RE.test(user)) fail("AGENTLINK_USER is required (lowercase [a-z0-9_-], 1-32 chars)");
  const token = env.AGENTLINK_TOKEN ?? "";
  if (!token) fail("AGENTLINK_TOKEN is required");

  let hubUrl: string | null = null;
  if (env.AGENTLINK_HUB_URL) {
    try {
      const u = new URL(env.AGENTLINK_HUB_URL);
      const proto = u.protocol === "https:" || u.protocol === "wss:" ? "https:" : "http:";
      hubUrl = `${proto}//${u.host}`;
    } catch {
      fail(`AGENTLINK_HUB_URL is not a URL: ${env.AGENTLINK_HUB_URL}`);
    }
  }
  const modeRaw = env.AGENTLINK_HUB_MODE ?? "";
  if (modeRaw && modeRaw !== "lan" && modeRaw !== "cloud") fail("AGENTLINK_HUB_MODE must be lan or cloud");
  // https:// means the website; AGENTLINK_HUB_MODE=lan keeps an https LAN hub on the ws link
  const hubMode: Config["hubMode"] = modeRaw === "cloud" || (modeRaw !== "lan" && hubUrl?.startsWith("https:")) ? "cloud" : "lan";
  if (hubMode === "cloud" && !hubUrl) fail("AGENTLINK_HUB_MODE=cloud needs AGENTLINK_HUB_URL (the website, https://...)");
  const hubId = env.AGENTLINK_HUB_ID || null;
  if (hubId !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(hubId)) fail("AGENTLINK_HUB_ID must be a hub id like the one on the hub page");
  // manual = no mDNS browsing. Without a pinned id there is nothing else to go on, so it needs a URL.
  const discovery = env.AGENTLINK_DISCOVERY === "manual" ? "manual" : "mdns";
  if (discovery === "manual" && !hubUrl && !hubId) fail("AGENTLINK_DISCOVERY=manual needs AGENTLINK_HUB_URL (or AGENTLINK_HUB_ID)");
  const scan = env.AGENTLINK_SCAN !== "0";
  let scanHosts: string[] | null = null;
  if (env.AGENTLINK_SCAN_HOSTS) {
    scanHosts = env.AGENTLINK_SCAN_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
    const bad = scanHosts.find((h) => !/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(h));
    if (bad) fail(`AGENTLINK_SCAN_HOSTS entry is not host or host:port: ${bad}`);
  }

  const port = Number(env.AGENTLINK_DAEMON_PORT ?? DEFAULT_PORTS.daemon);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("AGENTLINK_DAEMON_PORT is not a valid port");

  const dbPath = path.resolve(env.AGENTLINK_DAEMON_DB ?? `./data/daemon-${user}.sqlite`);
  const logPath = path.resolve(`./logs/daemon-${user}.log`);
  const hubName = env.AGENTLINK_HUB_NAME || null;
  const repin = env.AGENTLINK_HUB_REPIN === "1";
  const uiOrigin = env.AGENTLINK_UI_ORIGIN || "http://127.0.0.1:7780";
  if (!/^https?:\/\/[^/]+$/.test(uiOrigin)) fail("AGENTLINK_UI_ORIGIN must be an origin like http://127.0.0.1:7780");
  return { user, token, hubUrl, hubMode, discovery, hubName, repin, port, dbPath, logPath, uiOrigin, hubId, scan, scanHosts };
}
