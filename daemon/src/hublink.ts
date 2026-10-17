import { EventEmitter } from "node:events";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  HOP_LIMIT,
  PROTOCOL_VERSION,
  type ClientFrame,
  type Envelope,
  type HubConnState,
  type InboxItem,
  type ScreenUpdate,
  type ServerFrame,
} from "../../contracts/index.ts";
import type { Config } from "./config.ts";
import type { Discovery, HubTarget } from "./discovery.ts";
import { HubFinder, networkSignature, probeHubId } from "./finder.ts";
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
const NET_POLL_MS = 5_000;

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
  private idMismatch = false; // offline because the hub's id differs from the pinned one
  searching = true; // DaemonHealth.hub.searching: true while looking for the hub
  private auth: { stage: "challenge" | "welcome" | "done" | "closing"; nonce: string; hubId: string; cnonce: string } = {
    stage: "challenge",
    nonce: "",
    hubId: "",
    cnonce: "",
  };
  private session: string | null = null; // REST bearer from the current socket's welcome (v2)
  private impostorClosed = false;
  private finder: HubFinder;
  private netTimer: NodeJS.Timeout | null = null;
  private netSig = networkSignature();
  // Latest terminal screen per local agent. Memory only, never the outbox or SQLite (screens.md):
  // forwarded while connected; while offline only the latest survives, resent on reconnect.
  private screens = new Map<string, { screen: ScreenUpdate; at: string }>();

  constructor(
    private cfg: Config,
    private store: Store,
    private discovery: Discovery,
  ) {
    super();
    this.finder = new HubFinder(cfg, store, discovery);
    if (cfg.hubId && store.getKv("pinned_hub_id") !== cfg.hubId) {
      // AGENTLINK_HUB_ID is authoritative: pinned from the start, replacing any earlier pin
      store.setKv("pinned_hub_id", cfg.hubId);
      log("hub.pinned", { hub_id: cfg.hubId, source: "AGENTLINK_HUB_ID" });
    }
    discovery.on("up", (t: HubTarget) => {
      // A hub showed up on mDNS while we were waiting to retry: try now instead of after the backoff.
      // While offline over a hub_id mismatch, only the pinned hub coming back cuts the wait short.
      const pinnedBack = this.idMismatch && t.hubId !== null && t.hubId === this.pinnedId();
      if (this.state === "connecting" || this.state === "reconnecting" || pinnedBack) {
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
    this.netTimer = setInterval(() => void this.checkNetwork(), NET_POLL_MS);
    void this.connect();
  }

  /** hub_id for DaemonHealth: the pin, if any. */
  get hubId(): string | null {
    return this.pinnedId();
  }

  /** Polled every 5s: when this laptop's addresses change, the hub may have moved; look again now. */
  private async checkNetwork() {
    const sig = networkSignature();
    if (sig === this.netSig) return;
    log("hub.network_changed", { from: this.netSig, to: sig });
    this.netSig = sig;
    this.finder.scanSoon();
    this.discovery.refresh();
    if (this.ws && this.connected && this.target) {
      // still connected: keep the socket only if the hub still answers there with the pinned id
      const pin = this.pinnedId();
      const id = await probeHubId(this.target.url, 1_500);
      if (pin && id !== pin) {
        log("hub.search", { stage: "network_changed", detail: "the hub no longer answers at its address" });
        this.ws?.terminate();
      }
      return;
    }
    if (!this.ws && !this.connecting && this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.attempt = 0;
      void this.connect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.netTimer) clearInterval(this.netTimer);
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

    this.searching = true;
    const pin = this.pinnedId();
    let target: HubTarget | null = null;
    try {
      if (pin) {
        // Pinned: only an address whose GET /api/health reports the pinned hub_id is returned, so the
        // token in hello goes nowhere else (contracts/daemon-api.md, Discovery).
        target = await this.finder.find(pin);
        if (!target) target = await this.handleKnownMismatch(pin);
      } else {
        // First run, nothing pinned yet: take what mDNS or the manual URL offers. It is pinned only at
        // welcome, after its server_proof shows it knows the token.
        target = await this.discovery.resolve(null);
        if (target && this.finder.isDenied(target.url)) target = null;
      }
    } finally {
      this.connecting = false;
    }
    if (this.stopped) return;
    if (!target) {
      if (this.state === "offline") return; // offline over a hub_id mismatch; its own retry is set
      log("hub.no_target", { detail: pin ? "pinned hub not found yet" : "mDNS found no hub and AGENTLINK_HUB_URL is not set" });
      this.discovery.refresh();
      this.scheduleRetry();
      return;
    }
    this.target = target;

    const wsUrl = target.url.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 5_000 });
    this.ws = ws;
    this.lastFrameAt = Date.now();

    // v2 auth (hub-api.md "Auth"): send nothing until the hub's challenge, check its hub_id, answer
    // with an HMAC proof (the token itself never leaves this machine), then verify server_proof.
    this.auth = { stage: "challenge", nonce: "", hubId: "", cnonce: "" };
    this.session = null;
    ws.on("open", () => {
      this.welcomeTimer = setTimeout(() => {
        log("hub.welcome_timeout", { url: wsUrl, stage: this.auth.stage });
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
    this.session = null;
    if (this.stopped) return;

    if (this.impostorClosed) {
      // that address is deny-listed for this run; look elsewhere right away
      this.impostorClosed = false;
      this.searching = true;
      this.setState(this.everConnected ? "reconnecting" : "connecting");
      this.attempt = 0;
      this.finder.scanSoon();
      this.discovery.refresh();
      this.scheduleRetry();
      return;
    }
    if (this.idMismatch) {
      this.goOfflineForMismatch();
      return;
    }

    if (code === 4001 || code === 4002 || code === 4003) {
      // Auth failure, protocol mismatch, or another daemon took over this user: retry slowly.
      log("hub.offline", {
        code,
        detail: code === 4001 ? "auth failed" : code === 4002 ? "protocol mismatch" : "replaced by a newer daemon for this user",
      });
      this.setState("offline");
      this.searching = false; // the hub was found; it refused us
      this.attempt = 0;
      this.retryTimer = setTimeout(() => void this.connect(), AUTH_RETRY_MS);
      return;
    }
    this.setState(this.everConnected ? "reconnecting" : "connecting");
    this.searching = true;
    if (wasConnected) {
      // the link dropped: the hub may have moved, so look again right away, scan included
      this.attempt = 0;
      this.finder.scanSoon();
    }
    this.discovery.refresh();
    this.scheduleRetry();
  }

  // ------------------------------------------------------------------ hub_id pin

  private pinnedId(): string | null {
    return this.store.getKv("pinned_hub_id");
  }

  /**
   * The pinned hub wasn't found, but a known address (last known or the manual URL) answered with a
   * different hub_id. Log hub.id_changed and go offline, or re-pin with AGENTLINK_HUB_REPIN=1 (never
   * when the pin came from AGENTLINK_HUB_ID). Strangers found by the subnet scan don't count.
   */
  private async handleKnownMismatch(pin: string): Promise<HubTarget | null> {
    const mm = this.finder.mismatches[0];
    if (!mm) return null;
    this.target = { url: mm.url, via: mm.via, name: null, hubId: mm.hubId };
    if (!this.checkPin(mm.hubId, "precheck")) {
      this.goOfflineForMismatch();
      return null;
    }
    // re-pinned to the hub at this address
    log("hub.found", { via: mm.via, url: mm.url, hub_id: mm.hubId, repinned_from: pin });
    return this.target;
  }

  /**
   * Compare a hub's id with the pinned one. Pins on first sight. Returns false (and sets idMismatch)
   * when it differs and AGENTLINK_HUB_REPIN is not set.
   */
  private checkPin(gotId: string, stage: "precheck" | "welcome"): boolean {
    const pin = this.pinnedId();
    if (pin === null) {
      this.store.setKv("pinned_hub_id", gotId);
      log("hub.pinned", { hub_id: gotId, url: this.target?.url, via: this.target?.via });
      return true;
    }
    if (gotId === pin) {
      this.idMismatch = false;
      return true;
    }
    if (this.cfg.repin && !this.cfg.hubId) {
      this.store.setKv("pinned_hub_id", gotId);
      log("hub.repinned", { old_hub_id: pin, hub_id: gotId, url: this.target?.url, via: this.target?.via, stage });
      this.idMismatch = false;
      return true;
    }
    this.idMismatch = true;
    log("hub.id_changed", {
      level: "warn",
      expected_hub_id: pin,
      got_hub_id: gotId,
      url: this.target?.url,
      via: this.target?.via,
      stage,
      detail: this.cfg.hubId
        ? "this hub is not the AGENTLINK_HUB_ID this daemon was started with; not connecting, still searching"
        : "this hub is not the one this daemon pinned; staying offline. If the hub was really replaced, restart with AGENTLINK_HUB_REPIN=1",
    });
    return false;
  }

  private goOfflineForMismatch() {
    // That address answered with the wrong hub_id (at precheck, or worse, at welcome after passing
    // /api/health): skip it in every discovery stage for 10 minutes, so it never gets another hello.
    if (this.target) this.finder.deny(this.target.url, "hub_id mismatch");
    this.discovery.refresh();
    if (this.cfg.hubId) {
      // Started with AGENTLINK_HUB_ID: there is only one hub we will ever join, so keep looking now.
      this.idMismatch = false;
      this.searching = true;
      this.setState(this.everConnected ? "reconnecting" : "connecting");
      this.attempt = 0;
      this.finder.scanSoon();
      this.scheduleRetry();
      return;
    }
    this.setState("offline");
    this.attempt = 0;
    this.retryTimer = setTimeout(() => void this.connect(), AUTH_RETRY_MS);
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
    // Until the hub has proved it knows the token, only challenge and welcome are handled; anything
    // else (and anything after an impostor or hub_id mismatch) is ignored while the socket closes.
    if (this.auth.stage !== "done") {
      if (this.auth.stage === "challenge" && frame.op === "challenge") return this.onChallenge(frame);
      if (this.auth.stage === "welcome" && frame.op === "welcome") return this.onWelcome(frame);
      if (frame.op === "error") log("hub.error", { code: frame.code, detail: frame.message, stage: this.auth.stage });
      else if (this.auth.stage !== "closing") {
        log("hub.bad_handshake", { op: (frame as { op?: string }).op, stage: this.auth.stage });
        this.auth.stage = "closing";
        this.ws?.close(1000, "unexpected frame before auth");
      }
      return;
    }
    if (this.idMismatch) return;
    switch (frame.op) {
      case "welcome":
      case "challenge":
        return; // only valid during the handshake
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

  private onChallenge(frame: Extract<ServerFrame, { op: "challenge" }>) {
    const url = this.target?.url;
    if (typeof frame.nonce !== "string" || !/^[0-9a-f]{64}$/.test(frame.nonce) || typeof frame.hub_id !== "string" || !frame.hub_id) {
      log("hub.bad_handshake", { stage: "challenge", url, detail: "malformed challenge" });
      this.auth.stage = "closing";
      this.ws?.close(1000, "bad challenge");
      return;
    }
    if (frame.protocol !== PROTOCOL_VERSION) {
      log("hub.offline", { code: 4002, detail: `hub speaks protocol ${frame.protocol}, this daemon ${PROTOCOL_VERSION}`, url });
      this.auth.stage = "closing";
      this.ws?.close(4002, "protocol mismatch");
      return;
    }
    const pin = this.pinnedId();
    const repinAllowed = this.cfg.repin && !this.cfg.hubId;
    if (pin && frame.hub_id !== pin && !repinAllowed) {
      // Not the pinned hub, whatever /api/health said: close without sending a single frame.
      this.impostor("challenge", { expected_hub_id: pin, got_hub_id: frame.hub_id });
      return;
    }
    const cnonce = randomBytes(32).toString("hex");
    this.auth = { stage: "welcome", nonce: frame.nonce, hubId: frame.hub_id, cnonce };
    const proof = hmac(this.cfg.token, `agentlink-v2|c|${frame.nonce}|${frame.hub_id}|${this.cfg.user}|daemon|${cnonce}`);
    const sinceRaw = this.store.getKv("last_seq");
    const hello: ClientFrame = {
      op: "hello",
      role: "daemon",
      user: this.cfg.user,
      protocol: PROTOCOL_VERSION,
      cnonce,
      proof,
      ...(sinceRaw !== null ? { since_seq: Number(sinceRaw) } : {}),
    };
    this.write(hello);
  }

  /**
   * Close the socket to a host that isn't our hub: log hub.impostor, never try that address again
   * this run, and keep searching (contracts: challenge hub_id mismatch, or a bad server_proof).
   */
  private impostor(stage: "challenge" | "server_proof", detail: Record<string, unknown>) {
    const url = this.target?.url ?? null;
    log("hub.impostor", { level: "warn", stage, url, via: this.target?.via, ...detail });
    if (url) this.finder.deny(url, `impostor at ${stage}`);
    this.auth.stage = "closing";
    this.impostorClosed = true;
    this.ws?.close(1000, "not the pinned hub");
  }

  private onWelcome(frame: Extract<ServerFrame, { op: "welcome" }>) {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    // The hub must prove it knows the token before anything else is believed, pinning included.
    const expected = hmac(this.cfg.token, `agentlink-v2|s|${this.auth.cnonce}|${this.auth.nonce}|${this.auth.hubId}`);
    if (typeof frame.server_proof !== "string" || !safeEqualHex(frame.server_proof, expected) || frame.hub_id !== this.auth.hubId) {
      this.impostor("server_proof", { got_hub_id: frame.hub_id, detail: "server_proof did not verify; this host does not know the token" });
      return;
    }
    if (typeof frame.session !== "string" || !frame.session) {
      log("hub.bad_handshake", { stage: "welcome", detail: "welcome without a session" });
      this.auth.stage = "closing";
      this.ws?.close(1000, "no session");
      return;
    }
    this.auth.stage = "done";
    if (!this.checkPin(frame.hub_id, "welcome")) {
      this.ws?.close(1000, "hub_id mismatch"); // onClose sees idMismatch
      return;
    }
    this.session = frame.session;
    this.hubName = frame.hub_name;
    this.attempt = 0;
    this.everConnected = true;
    this.searching = false;
    if (this.target) this.finder.recordSuccess(this.target.url);
    this.setState("connected");
    log("hub.connected", { url: this.target?.url, via: this.target?.via, hub_id: frame.hub_id, hub_name: frame.hub_name });

    for (const s of this.store.sessions()) {
      this.write({ op: "session.upsert", session: { agent: s.agent, kind: s.kind, status: s.status, task: s.task } });
    }
    // after the upserts: the hub only takes screens for sessions that exist and are online
    for (const { screen } of this.screens.values()) this.write({ op: "screen", screen });
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
    logMsg("msg.received", note, { local: true, reason });
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
    this.screens.delete(agent);
    this.write({ op: "session.remove", agent });
  }

  // ------------------------------------------------------------------ screens

  putScreen(screen: ScreenUpdate) {
    this.screens.set(screen.agent, { screen, at: new Date().toISOString() });
    if (this.connected) this.write({ op: "screen", screen });
  }

  getScreen(agent: string) {
    return this.screens.get(agent) ?? null;
  }

  /** Local only: the hub drops a screen when its session goes offline or is removed. */
  deleteScreen(agent: string) {
    this.screens.delete(agent);
  }

  // ------------------------------------------------------------------ REST proxy

  /** Call the hub REST API. Throws HubOffline when there is no live hub connection. */
  async rest(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    if (!this.connected || !this.target || !this.session) throw new HubOffline();
    const res = await fetch(this.target.url + pathAndQuery, {
      method,
      headers: {
        // v2: the per-socket session from welcome; the shared token never goes over the network
        authorization: `Bearer ${this.session}`,
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

/** HMAC-SHA256 hex, keyed with the shared token (hub-api.md "Auth"). */
function hmac(token: string, msg: string): string {
  return createHmac("sha256", token).update(msg).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export class HubOffline extends Error {
  constructor() {
    super("hub_offline");
  }
}
