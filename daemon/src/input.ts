import http from "node:http";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { log } from "./log.ts";

// Local terminal input (contracts/input.md): the UI's command bar -> this daemon (memory only) -> the
// bridge's SSE stream -> the panes. Only the HTTP handlers for /v1/panes/input* hold a reference to
// this object; the hub link never does, so nothing that arrives from the hub can reach the panes.
// One exception, cloud mode only (input.md "Cloud input"): the website's signed input frames, checked by
// CloudInputGate (cloudinput.ts), which gets nothing but submit(). The text is never logged.
// Emits "finished" (id, state, results) when a request is done or failed.

export type InputState = "pending" | "done" | "failed";

interface InputRequest {
  id: string;
  agents: string[];
  text: string;
  submit: boolean;
  state: InputState;
  results?: Record<string, string>;
  createdAt: number;
  deliveredAt: number | null;
}

// The two waits can be shortened for tests (AGENTLINK_INPUT_HOLD_MS / AGENTLINK_INPUT_RESULT_MS).
const HOLD_MS = Number(process.env.AGENTLINK_INPUT_HOLD_MS) || 60_000; // undelivered requests wait this long for a bridge
const RESULT_WAIT_MS = Number(process.env.AGENTLINK_INPUT_RESULT_MS) || 60_000; // delivered, no result by then -> failed
const RETAIN_MS = 10 * 60_000;
const KEEPALIVE_MS = 15_000;

export class InputChannel extends EventEmitter {
  private requests = new Map<string, InputRequest>();
  private bridge: http.ServerResponse | null = null;
  private sweepTimer: NodeJS.Timeout;
  private keepaliveTimer: NodeJS.Timeout;

  constructor() {
    super();
    this.sweepTimer = setInterval(() => this.sweep(), 1_000);
    this.keepaliveTimer = setInterval(() => this.bridge?.write(": keepalive\n\n"), KEEPALIVE_MS);
  }

  close() {
    clearInterval(this.sweepTimer);
    clearInterval(this.keepaliveTimer);
    this.bridge?.end();
    this.bridge = null;
  }

  get bridgeConnected() {
    return this.bridge !== null;
  }

  /** Accept a request from the UI. The caller has already checked the origin, header and body. */
  submit(agents: string[], text: string, submit: boolean): string {
    const req: InputRequest = { id: randomUUID(), agents, text, submit, state: "pending", createdAt: Date.now(), deliveredAt: null };
    this.requests.set(req.id, req);
    log("input.requested", { id: req.id, agents, chars: text.length });
    this.deliver(req);
    return req.id;
  }

  /** The bridge's SSE stream. A newer connection replaces the older one. */
  attachBridge(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    if (this.bridge) {
      log("input.bridge_replaced");
      this.bridge.end();
    }
    this.bridge = res;
    log("input.bridge_connected");
    req.on("close", () => {
      if (this.bridge === res) {
        this.bridge = null;
        log("input.bridge_disconnected");
      }
    });
    for (const r of this.requests.values()) if (r.state === "pending" && r.deliveredAt === null) this.deliver(r);
  }

  private deliver(r: InputRequest) {
    if (!this.bridge || this.bridge.writableEnded) return;
    const data = JSON.stringify({ id: r.id, agents: r.agents, text: r.text, submit: r.submit });
    this.bridge.write(`event: input\ndata: ${data}\n\n`);
    r.deliveredAt = Date.now();
    log("input.delivered", { id: r.id });
  }

  /** The bridge's report. Returns false for an unknown or already finished id. */
  result(id: string, results: Record<string, string>): "ok" | "unknown" | "finished" {
    const r = this.requests.get(id);
    if (!r) return "unknown";
    if (r.state !== "pending") return "finished";
    const kept: Record<string, string> = {};
    for (const a of r.agents) if (typeof results[a] === "string") kept[a] = results[a].slice(0, 200);
    r.results = kept;
    r.state = "done";
    log("input.result", { id, results: kept });
    this.emit("finished", id, r.state, kept);
    return "ok";
  }

  status(id: string) {
    const r = this.requests.get(id);
    if (!r) return null;
    return { id: r.id, state: r.state, ...(r.results ? { results: r.results } : {}) };
  }

  private fail(r: InputRequest, why: string) {
    r.state = "failed";
    r.results = Object.fromEntries(r.agents.map((a) => [a, `failed: ${why}`]));
    log("input.failed", { id: r.id, reason: why });
    this.emit("finished", r.id, r.state, r.results);
  }

  private sweep() {
    const now = Date.now();
    for (const r of this.requests.values()) {
      if (r.state === "pending" && r.deliveredAt === null && now - r.createdAt > HOLD_MS) this.fail(r, "no_bridge");
      else if (r.state === "pending" && r.deliveredAt !== null && now - r.deliveredAt > RESULT_WAIT_MS) this.fail(r, "no_result");
      if (now - r.createdAt > RETAIN_MS) this.requests.delete(r.id);
    }
  }
}
