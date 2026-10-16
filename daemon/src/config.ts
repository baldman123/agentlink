import path from "node:path";
import { DEFAULT_PORTS } from "../../contracts/index.ts";

export interface Config {
  user: string;
  token: string;
  hubUrl: string | null; // manual fallback, normalized to http://host:port
  discovery: "mdns" | "manual";
  hubName: string | null; // when set, mDNS accepts only a hub whose TXT name or hub_id equals it
  repin: boolean; // AGENTLINK_HUB_REPIN=1: accept a hub whose hub_id differs from the pinned one, and re-pin
  port: number;
  dbPath: string;
  logPath: string;
  uiOrigin: string; // the only Origin allowed to POST /v1/panes/input (contracts/input.md)
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
  const discovery = env.AGENTLINK_DISCOVERY === "manual" ? "manual" : "mdns";
  if (discovery === "manual" && !hubUrl) fail("AGENTLINK_DISCOVERY=manual needs AGENTLINK_HUB_URL");

  const port = Number(env.AGENTLINK_DAEMON_PORT ?? DEFAULT_PORTS.daemon);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) fail("AGENTLINK_DAEMON_PORT is not a valid port");

  const dbPath = path.resolve(env.AGENTLINK_DAEMON_DB ?? `./data/daemon-${user}.sqlite`);
  const logPath = path.resolve(`./logs/daemon-${user}.log`);
  const hubName = env.AGENTLINK_HUB_NAME || null;
  const repin = env.AGENTLINK_HUB_REPIN === "1";
  const uiOrigin = env.AGENTLINK_UI_ORIGIN || "http://127.0.0.1:7780";
  if (!/^https?:\/\/[^/]+$/.test(uiOrigin)) fail("AGENTLINK_UI_ORIGIN must be an origin like http://127.0.0.1:7780");
  return { user, token, hubUrl, discovery, hubName, repin, port, dbPath, logPath, uiOrigin };
}
