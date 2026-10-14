import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  HOP_LIMIT,
  PROTOCOL_VERSION,
  type ClientFrame,
  type Envelope,
  type HubConnState,
  type InboxItem,
  type ServerFrame,
} from "../../contracts/index.ts";
import type { Config } from "./config.ts";
import type { Discovery, HubTarget } from "./discovery.ts";
import { log, logMsg } from "./log.ts";
import type { Store } from "./store.ts";

const PING_INTERVAL_MS = 15_000;
const SILENT_CLOSE_MS = 45_000;
const WELCOME_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const AUTH_RETRY_MS = 30_000;
const RESEND_AFTER_MS = 5_000;
const RESEND_MAX_MS = 60_000;
const PUMP_INTERVAL_MS = 1_000;
const SYSTEM_AGENT = "agentlink"; // sender of local status notes

/**
 * The daemon's single WebSocket to the hub. Owns reconnects, the outbox pump, inbox intake and
 * session forwarding. Emits "inbox" (InboxItem) for every newly stored inbox row and "state".
 */
export class HubLink extends EventEmitter {
  state: HubConnState = "connecting";
  target: HubTarget | null = null;
  hubName: string | null = null;

  private ws: WebSocket | null = null;
  private everConnected = false;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private welcomeTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private stopped = false;
  private connecting = false;

  constructor(
    private cfg: Config,
    private store: Store,
    private discovery: Discovery,
  ) {
    super();
    discovery.on("up", () => {
      // A hub showed up on mDNS while we were waiting to retry: try now instead of after the backoff.
      if (this.state === "connecting" || this.state === "reconnecting") {
        if (this.retryTimer && !this.ws) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
          void this.connect();
        }
      }
    });
  }

  start() {
    this.pumpTimer = setInterval(() => this.pump(false), PUMP_INTERVAL_MS);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.retryTimer, this.welcomeTimer, this.heartbeatTimer, this.pingTimer]) if (t) clearTimeout(t);
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.ws?.close(1000, "daemon shutdown");
  }

  get connected() {
    return this.state === "connected";
  }

  /** Base URL for hub REST calls (only meaningful while a target is known). */
  get hubHttp(): string | null {
    return this.target?.url ?? null;
  }

  // ------------------------------------------------------------------ connection

  private setState(s: HubConnState) {
    if (this.state === s) return;
    this.state = s;
    log("hub.state", { state: s });
    this.emit("state", s);
  }

  private async connect() {
    if (this.stopped || this.connecting || this.ws) return;
    this.connecting = true;
    this.retryTimer = null;
    if (this.state !== "offline") this.setState(this.everConnected ? "reconnecting" : "connecting");

    let target: HubTarget | null = null;
    try {
      target = await this.discovery.resolve();
    } finally {
      this.connecting = false;
    }
    if (this.stopped) return;
    if (!target) {
      log("hub.no_target", { detail: "mDNS found no hub and AGENTLINK_HUB_URL is not set" });
      this.discovery.refresh();
      this.scheduleRetry();
      return;
    }
    this.target = target;

    const wsUrl = target.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 5_000 });
    this.ws = ws;
    this.lastFrameAt = Date.now();

    ws.on("open", () => {
      const sinceRaw = this.store.getKv("last_seq");
      const hello: ClientFrame = {
        op: "hello",
        token: this.cfg.token,
        role: "daemon",
        user: this.cfg.user,
        protocol: PROTOCOL_VERSION,
        ...(sinceRaw !== null ? { since_seq: Number(sinceRaw) } : {}),
      };
      this.write(hello);
      this.welcomeTimer = setTimeout(() => {
        log("hub.welcome_timeout", { url: wsUrl });
        ws.terminate();
      }, WELCOME_TIMEOUT_MS);
    });
    ws.on("message", (data) => {
      this.lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        log("hub.bad_frame", { detail: "unparseable JSON" });
        return;
      }
      try {
        this.onFrame(frame);
      } catch (err) {
        log("hub.frame_error", { op: (frame as { op?: string }).op, detail: String(err) });
      }
    });
    ws.on("error", (err) => log("hub.socket_error", { url: wsUrl, detail: String(err.message ?? err) }));
    ws.on("close", (code, reasonBuf) => this.onClose(ws, code, reasonBuf.toString()));
  }

  private onClose(ws: WebSocket, code: number, reason: string) {
    if (this.ws !== ws) return;
    this.ws = null;
    for (const t of [this.welcomeTimer, this.heartbeatTimer, this.pingTimer]) if (t) clearTimeout(t);
    this.welcomeTimer = this.heartbeatTimer = this.pingTimer = null;
    const wasConnected = this.state === "connected";
    log("hub.disconnected", { url: this.target?.url, code, reason, was_connected: wasConnected });
    if (this.stopped) return;

    if (code === 4001 || code === 4002 || code === 4003) {
      // Auth failure, protocol mismatch, or another daemon took over this user: retry slowly.
      log("hub.offline", {
        code,
        detail: code === 4001 ? "auth failed" : code === 4002 ? "protocol mismatch" : "replaced by a newer daemon for this user",
      });
      this.setState("offline");
      this.attempt = 0;
      this.retryTimer = setTimeout(() => void this.connect(), AUTH_RETRY_MS);
      return;
    }
    this.setState(this.everConnected ? "reconnecting" : "connecting");
    this.discovery.refresh();
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2)); // jitter in [base/2, base]
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private write(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  // ------------------------------------------------------------------ frames

  private onFrame(frame: ServerFrame) {
    switch (frame.op) {
      case "welcome":
        return this.onWelcome(frame);
      case "snapshot":
        this.bumpSeq(frame.last_seq);
        return;
      case "event":
        this.bumpSeq(frame.frame.seq);
        this.emit("hub_event", frame.frame);
        return;
      case "accepted":
        return this.onAccepted(frame.id);
      case "rejected":
        return this.onRejected(frame.id, frame.reason);
      case "deliver":
        return this.onDeliver(frame.envelope);
      case "error":
        log("hub.error", { code: frame.code, detail: frame.message });
        return;
      case "pong":
        return;
      default:
        log("hub.unknown_frame", { op: (frame as { op?: string }).op });
    }
  }

  private onWelcome(frame: Extract<ServerFrame, { op: "welcome" }>) {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    this.hubName = frame.hub_name;
    this.attempt = 0;
    this.everConnected = true;
    this.setState("connected");
    log("hub.connected", { url: this.target?.url, via: this.target?.via, hub_id: frame.hub_id, hub_name: frame.hub_name });

    for (const s of this.store.sessions()) {
      this.write({ op: "session.upsert", session: { agent: s.agent, kind: s.kind, status: s.status, task: s.task } });
    }
    this.pump(true);

    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastFrameAt > SILENT_CLOSE_MS) {
        log("hub.silent", { detail: `no frame for ${SILENT_CLOSE_MS}ms, dropping socket` });
        this.ws?.terminate();
        return;
      }
      this.write({ op: "ping" });
    }, PING_INTERVAL_MS);
  }

  private heartbeat() {
    this.write({ op: "heartbeat", agents: this.store.sessions().map((s) => s.agent) });
  }

  private bumpSeq(seq: number) {
    if (!Number.isFinite(seq)) return;
    const cur = Number(this.store.getKv("last_seq") ?? -1);
    if (seq > cur) this.store.setKv("last_seq", String(seq));
  }

  private onAccepted(id: string) {
    const item = this.store.outboxGet(id);
    if (!item) return; // duplicate accept for a retry we already dequeued
    this.store.dequeue(id);
    logMsg("msg.accepted", item.envelope, { attempts: item.attempts });
  }

  private onRejected(id: string, reason: string) {
    const item = this.store.outboxGet(id);
    if (!item) return;
    this.store.dequeue(id);
    const env = item.envelope;
    logMsg("msg.rejected", env, { reason });
    const note: Envelope = {
      id: randomUUID(),
      from: `${this.cfg.user}/${SYSTEM_AGENT}`,
      to: env.from,
      reply_to: env.id,
      hops: 0,
      type: "status",
      body: { text: reason, rejected_id: env.id, rejected_to: env.to },
      timestamp: new Date().toISOString(),
    };
    const stored = this.store.inboxInsert(note);
    if (stored) this.emit("inbox", stored);
  }

  private onDeliver(env: Envelope) {
    if (!env || typeof env.id !== "string" || typeof env.from !== "string" || typeof env.to !== "string") {
      log("msg.dropped", { reason: "bad_envelope", id: (env as { id?: string } | undefined)?.id ?? null });
      return;
    }
    if (typeof env.hops !== "number" || env.hops > HOP_LIMIT) {
      logMsg("msg.dropped", env, { reason: "hop_limit" });
      this.write({ op: "ack", id: env.id }); // ack so the hub stops redelivering it
      return;
    }
    const stored: InboxItem | null = this.store.inboxInsert(env);
    logMsg("msg.received", env, { duplicate: !stored, remote: stored?.remote });
    this.write({ op: "ack", id: env.id });
    if (stored) {
      const agent = env.to.split("/")[1];
      if (agent && agent !== "*") this.store.sessionTouch(agent);
      this.emit("inbox", stored);
    }
  }

  // ------------------------------------------------------------------ outbox

  /** Send due outbox items in order. `all` ignores next_attempt_at (used right after (re)connect). */
  pump(all: boolean) {
    if (!this.connected) return;
    const now = new Date();
    const items = all ? this.store.outboxAll() : this.store.outboxDue(now.toISOString());
    for (const item of items) {
      if (!this.write({ op: "send", envelope: item.envelope })) return;
      const attempts = item.attempts + 1;
      const wait = Math.min(RESEND_MAX_MS, RESEND_AFTER_MS * 2 ** (attempts - 1));
      this.store.markAttempt(
        item.envelope.id,
        attempts,
        new Date(now.getTime() + wait).toISOString(),
        attempts > 1 ? "no accepted/rejected within timeout, resent" : null,
      );
      logMsg("msg.sent", item.envelope, { attempt: attempts });
    }
  }

  // ------------------------------------------------------------------ sessions

  forwardUpsert(agent: string) {
    const s = this.store.sessions().find((x) => x.agent === agent);
    if (s) this.write({ op: "session.upsert", session: { agent: s.agent, kind: s.kind, status: s.status, task: s.task } });
  }

  forwardRemove(agent: string) {
    this.write({ op: "session.remove", agent });
  }

  // ------------------------------------------------------------------ REST proxy

  /** Call the hub REST API. Throws HubOffline when there is no live hub connection. */
  async rest(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.connected || !this.target) throw new HubOffline();
    const res = await fetch(this.target.url + pathAndQuery, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: "bad_hub_response", detail: text.slice(0, 200) };
      }
    }
    return { status: res.status, body: parsed };
  }
}

export class HubOffline extends Error {
  constructor() {
    super("hub_offline");
  }
}
