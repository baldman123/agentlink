// Claude plan usage reporter (contracts/usage.ts). Every USAGE_INTERVAL_MS it asks Claude Code for the /usage
// numbers and POSTs them to the website. Cloud mode only; AGENTLINK_USAGE=0 turns it off.
//
// The ask is one short-lived `claude -p` that answers a get_usage control request on stdin and exits when stdin
// closes. It makes no model call. Claude Code reads its own login to fetch the numbers; this file never touches a
// token. Hooks, MCP servers and user settings are skipped (--setting-sources project, --strict-mcp-config) so the
// probe doesn't fire SessionStart hooks every five minutes, and --no-session-persistence keeps it out of history.
import { spawn } from "node:child_process";
import os from "node:os";
import { parseUsage, USAGE_INTERVAL_MS, type ClaudeUsage } from "../../contracts/usage.ts";
import type { DaemonHubLink } from "./link.ts";
import { log } from "./log.ts";

const PROBE_TIMEOUT_MS = 45_000;
const REQUEST_ID = "agentlink-usage";

export type UsageProbe = () => Promise<ClaudeUsage | null>;

/** Finds the get_usage control_response among stream-json lines; its `response`, or undefined. */
export function findUsageResponse(stdout: string): unknown {
  for (const line of stdout.split("\n")) {
    if (!line.includes(REQUEST_ID)) continue;
    try {
      const m = JSON.parse(line);
      if (m?.type === "control_response" && m.response?.request_id === REQUEST_ID) {
        if (m.response.subtype !== "success") throw new Error(String(m.response.error ?? "get_usage failed"));
        return m.response.response;
      }
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  return undefined;
}

export function claudeProbe(bin = process.env.AGENTLINK_CLAUDE_BIN || "claude"): UsageProbe {
  return () =>
    new Promise((resolve, reject) => {
      const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "project"];
      const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: process.env });
      let out = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("claude usage probe timed out"));
      }, PROBE_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (out.length < 1_000_000) out += c;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const resp = findUsageResponse(out);
          if (resp === undefined) return reject(new Error(`claude exited ${code} without a usage answer`));
          resolve(parseUsage(resp));
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.end(JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
    });
}

export class UsageReporter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private last: ClaudeUsage | null = null;
  private lastSent = 0;

  constructor(
    private hub: DaemonHubLink,
    private probe: UsageProbe = claudeProbe(),
    private intervalMs = USAGE_INTERVAL_MS,
  ) {}

  start() {
    // first sample once the link has had a moment to come up, then on the interval
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
    }, Math.min(15_000, this.intervalMs));
    this.hub.on("state", () => {
      // reconnected with a sample the site may have missed: resend it without probing again
      if (this.hub.connected && this.last && Date.now() - this.lastSent > this.intervalMs) void this.send(this.last);
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer); // clearTimeout clears intervals too
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const usage = await this.probe();
      if (!usage) {
        log("usage.unavailable", { detail: "no plan rate limits (API key or 3P provider?)" });
        return;
      }
      this.last = usage;
      if (this.hub.connected) await this.send(usage);
    } catch (err) {
      log("usage.probe_failed", { detail: String((err as Error).message ?? err) });
    } finally {
      this.running = false;
    }
  }

  private async send(usage: ClaudeUsage) {
    try {
      const r = await this.hub.rest("POST", "/api/usage", { usage });
      if (r.status === 204) this.lastSent = Date.now();
      else log("usage.post_failed", { status: r.status });
    } catch (err) {
      log("usage.post_failed", { detail: String((err as Error).message ?? err) });
    }
  }
}
