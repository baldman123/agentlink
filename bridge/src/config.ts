import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  };
}
