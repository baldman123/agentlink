import fs from "node:fs";
import path from "node:path";
import type { Envelope } from "../../contracts/index.ts";

export type MsgEvent = "msg.queued" | "msg.sent" | "msg.accepted" | "msg.rejected" | "msg.received" | "msg.dropped";

let stream: fs.WriteStream | null = null;
let user = "";

export function initLog(logPath: string, u: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  stream = fs.createWriteStream(logPath, { flags: "a" });
  user = u;
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "daemon", user, event, ...fields });
  process.stdout.write(line + "\n");
  stream?.write(line + "\n");
}

export function logMsg(event: MsgEvent, env: Envelope, extra: Record<string, unknown> = {}) {
  log(event, { id: env.id, from: env.from, to: env.to, type: env.type, hops: env.hops, ...extra });
}
