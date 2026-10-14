import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Envelope } from "../../contracts/index.ts";

const LOG_FILE = process.env.AGENTLINK_HUB_LOG ?? "logs/hub.log";
try {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
} catch {}

export type MsgLogEvent = "msg.accepted" | "msg.delivered" | "msg.dropped" | "msg.rejected";

export function logMsg(event: MsgLogEvent, env: Partial<Envelope>, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: "hub",
    event,
    id: env.id,
    from: env.from,
    to: env.to,
    type: env.type,
    hops: env.hops,
    ...extra,
  });
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

/** Non-message operational log line (startup, connections, errors). Stdout only. */
export function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "hub", event, ...data }));
}
