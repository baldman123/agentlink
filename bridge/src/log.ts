import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope } from "../../contracts/index.ts";

let logPath: string | null = null;
let user = "";

export function initLog(path: string, u: string): void {
  mkdirSync(dirname(path), { recursive: true });
  logPath = path;
  user = u;
}

/** One JSON line to stdout and logs/bridge-<user>.log. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "bridge", user, event, ...fields });
  process.stdout.write(line + "\n");
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n");
    } catch {}
  }
}

export function logMsg(event: string, e: Envelope, extra: Record<string, unknown> = {}): void {
  log(event, { id: e.id, from: e.from, to: e.to, type: e.type, hops: e.hops, ...extra });
}
