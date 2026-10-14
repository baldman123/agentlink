import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORTS } from "../../contracts/index.ts";

export interface BridgeConfig {
  user: string;
  daemonUrl: string;
  session: string; // C4_SESSION
  stateDir: string; // ~/.claude4/$C4_SESSION: panes registry + board.md
  tmuxSocket: string | null; // tmux -L <socket>; null = the default server (where claude4 runs)
  direct: boolean;
  dbPath: string;
  logPath: string;
  syncMs: number;
  refreshMs: number; // PUT even when nothing changed, to keep last_activity fresh
  backlogMs: number; // on the very first run, older unhandled inbox items are recorded, not pasted
  shareScreens: boolean; // AGENTLINK_SHARE_SCREENS=1 (contracts/screens.md); off by default
  screenMs: number; // capture interval per pane
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The shared token, used only to redact it from shared screens: AGENTLINK_TOKEN, else the file team-up.sh
 * writes (<repo>/data/.token). Never logged.
 */
export function loadToken(env = process.env): string | null {
  if (env.AGENTLINK_TOKEN) return env.AGENTLINK_TOKEN;
  try {
    return readFileSync(join(REPO_ROOT, "data", ".token"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

const USER_RE = /^[a-z0-9_-]{1,32}$/;

export function loadConfig(env = process.env): BridgeConfig {
  const user = env.AGENTLINK_USER ?? "";
  if (!USER_RE.test(user)) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), component: "bridge", event: "config.error", detail: "AGENTLINK_USER is required" }));
    process.exit(1);
  }
  const port = Number(env.AGENTLINK_DAEMON_PORT ?? DEFAULT_PORTS.daemon);
  const session = env.C4_SESSION || "claude4";
  return {
    user,
    daemonUrl: `http://127.0.0.1:${port}`,
    session,
    stateDir: resolve(env.C4_STATE_DIR || join(homedir(), ".claude4", session)),
    tmuxSocket: env.C4_TMUX_SOCKET || null,
    direct: env.AGENTLINK_BRIDGE_DIRECT === "1",
    dbPath: resolve(env.AGENTLINK_BRIDGE_DB || `./data/bridge-${user}.json`),
    logPath: resolve(env.AGENTLINK_BRIDGE_LOG || `./logs/bridge-${user}.log`),
    syncMs: Number(env.AGENTLINK_BRIDGE_SYNC_MS) || 3_000,
    refreshMs: 20_000,
    backlogMs: Number(env.AGENTLINK_BRIDGE_BACKLOG_MS) || 10 * 60_000,
    shareScreens: env.AGENTLINK_SHARE_SCREENS === "1",
    screenMs: Number(env.AGENTLINK_SCREEN_MS) || 1_000,
  };
}
