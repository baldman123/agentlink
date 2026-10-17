import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { log } from "./log.ts";

// Cloud input (contracts/input.md "Cloud input", contracts/cloud-api.md): the website lets the
// signed-in owner type into their OWN panes. The API sends a signed frame on this user's private
// Realtime channel input:<user>; this file decides whether a frame may reach the panes. It is the only
// way anything from the hub side gets to the bridge, and it gets nothing but this narrow gate.
//
// Checks, all of them, before a frame is handed to the bridge:
//   - sig: HMAC-SHA256 keyed with sha256(access code), which only the API (it stores that hash) and this
//     daemon (it has the code) know. A misconfigured channel policy alone can't let someone else type here.
//   - user is this daemon's user; at is within 60s; the id is new (no replays);
//   - agents are this team's panes (orchestrator, worker-1..4), no duplicates; text is 1..4000 chars.
// The text is never logged.

export const INPUT_AGENTS = ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"];
const MAX_SKEW_MS = 60_000;
const SEEN_KEEP_MS = 10 * 60_000;

export interface CloudInputFrame {
  id: string;
  user: string;
  agents: string[];
  text: string;
  submit: boolean;
  at: string;
  sig: string;
}

/** The part of InputChannel (input.ts) the cloud gate may use: submit only. */
export interface InputSink {
  readonly bridgeConnected: boolean;
  /** Returns the local request id. */
  submit(agents: string[], text: string, submit: boolean): string;
}

export type CheckResult = { ok: true; id: string; agents: string[]; text: string; submit: boolean } | { ok: false; reason: string };
export type GateResult = { ok: true; localId: string } | { ok: false; reason: string };

export function inputSigKey(accessCode: string): string {
  return createHash("sha256").update(accessCode).digest("hex");
}

export function inputSigMessage(f: Omit<CloudInputFrame, "sig">): string {
  return ["agentlink-input-v1", f.user, f.id, f.at, f.agents.join(","), f.submit ? "1" : "0", f.text].join("\n");
}

export function signInput(accessCode: string, f: Omit<CloudInputFrame, "sig">): string {
  return createHmac("sha256", inputSigKey(accessCode)).update(inputSigMessage(f)).digest("hex");
}

export class CloudInputGate {
  private key: string;
  private seen = new Map<string, number>(); // frame id -> when accepted

  constructor(
    private user: string,
    accessCode: string,
    private sink: InputSink,
  ) {
    this.key = inputSigKey(accessCode);
  }

  /** Check one frame from Realtime and hand it to the bridge, only if every check passes. */
  handle(raw: unknown, now = Date.now()): GateResult {
    const r = this.check(raw, now);
    if (!r.ok) return r;
    const localId = this.sink.submit(r.agents, r.text, r.submit);
    log("input.cloud_accepted", { id: r.id, local_id: localId, agents: r.agents, chars: r.text.length });
    return { ok: true, localId };
  }

  /** Every check, without typing anything. A frame that passes is recorded, so it can't be replayed. */
  check(raw: unknown, now = Date.now()): CheckResult {
    const refuse = (reason: string, extra: Record<string, unknown> = {}): CheckResult => {
      log("input.cloud_refused", { level: "warn", reason, id: typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id.slice(0, 64) : null, ...extra });
      return { ok: false, reason };
    };
    const f = raw as Partial<CloudInputFrame> | null;
    if (!f || typeof f !== "object") return refuse("bad_frame");
    if (typeof f.id !== "string" || !/^[0-9a-f-]{36}$/.test(f.id)) return refuse("bad_id");
    if (typeof f.sig !== "string" || !/^[0-9a-f]{64}$/.test(f.sig)) return refuse("bad_sig");
    if (typeof f.user !== "string" || typeof f.at !== "string" || typeof f.text !== "string" || typeof f.submit !== "boolean" || !Array.isArray(f.agents) || !f.agents.every((a) => typeof a === "string"))
      return refuse("bad_frame");
    // the signature first: nothing else about an unsigned frame is worth believing
    const expected = createHmac("sha256", this.key).update(inputSigMessage(f as CloudInputFrame)).digest("hex");
    if (!timingSafeEqual(Buffer.from(f.sig), Buffer.from(expected))) return refuse("bad_sig");
    if (f.user !== this.user) return refuse("wrong_user", { user: f.user });
    const at = Date.parse(f.at);
    if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) return refuse("stale", { at: f.at });
    this.sweep(now);
    if (this.seen.has(f.id)) return refuse("replay");
    if (f.agents.length < 1 || f.agents.length > INPUT_AGENTS.length || new Set(f.agents).size !== f.agents.length || !f.agents.every((a) => INPUT_AGENTS.includes(a)))
      return refuse("bad_agents", { agents: f.agents.slice(0, 8) });
    if (f.text.length < 1 || f.text.length > 4000) return refuse("bad_text", { chars: f.text.length });
    this.seen.set(f.id, now);
    return { ok: true, id: f.id, agents: f.agents, text: f.text, submit: f.submit };
  }

  private sweep(now: number) {
    for (const [id, t] of this.seen) if (now - t > SEEN_KEEP_MS) this.seen.delete(id);
  }
}
