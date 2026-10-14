import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  ADDRESS_RE,
  HOP_LIMIT,
  PROTOCOL_VERSION,
  SESSION_TIMEOUT_MS,
  type ClientFrame,
  type ClientRole,
  type ContextEntry,
  type ContextWrite,
  type Envelope,
  type EventFrame,
  type HubEvent,
  type MessageType,
  type ServerFrame,
  type SessionKind,
  type SessionStatus,
  type StoredMessage,
  type UserPresence,
} from "../../contracts/index.ts";
import { CONTEXT_KINDS, HubDb, rowToSession, toEnvelope } from "./db.ts";
import { logInfo, logMsg } from "./log.ts";

export interface HubOptions {
  port: number;
  host?: string;
  token: string;
  dbPath: string;
  hubName: string;
  helloTimeoutMs?: number;
  socketIdleMs?: number;
  sweepIntervalMs?: number;
  sessionTimeoutMs?: number;
}

interface Conn {
  ws: WebSocket;
  authed: boolean;
  role?: ClientRole;
  user?: string;
  ip?: string;
  lastSeen: number;
}

const PART_RE = /^[a-z0-9_-]{1,32}$/;
const KEY_RE = /^[a-z0-9._-]{1,64}$/;
const MESSAGE_TYPES: MessageType[] = ["task", "result", "chat", "context_update", "status"];
const SESSION_KINDS: SessionKind[] = ["orchestrator", "worker", "human"];
const SESSION_STATUSES: SessionStatus[] = ["idle", "working", "waiting", "error", "offline"];

const userOf = (addr: string) => addr.split("/")[0];
const isAgentAddress = (a: unknown): a is string => typeof a === "string" && ADDRESS_RE.test(a) && !a.endsWith("/*");
const isTarget = (a: unknown): a is string => a === "*" || (typeof a === "string" && ADDRESS_RE.test(a));

export class Hub {
  readonly db: HubDb;
  readonly hubId: string;
  readonly server: Server;
  private wss: WebSocketServer;
  private conns = new Set<Conn>();
  private daemons = new Map<string, Conn>();
  private seq: number;
  private sweepTimer?: NodeJS.Timeout;

  constructor(readonly opts: HubOptions) {
    this.db = new HubDb(opts.dbPath);
    this.hubId = this.db.hubId();
    this.seq = this.db.lastSeq();
    // Sessions from a previous run have no live daemon yet.
    for (const s of this.db.allSessionRows()) if (!s.offline) this.db.setOffline(s.address, true);
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs ?? 5_000);
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : this.opts.port);
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const c of this.conns) c.ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.server.close(() => r()));
    this.db.db.close();
  }

  // ------------------------------------------------------------------ events
  private emit(event: HubEvent): EventFrame {
    const frame: EventFrame = { seq: ++this.seq, at: new Date().toISOString(), event };
    this.db.insertEvent(frame.seq, frame.at, event);
    for (const c of this.conns) if (c.authed) this.sendFrame(c, { op: "event", frame });
    return frame;
  }

  private sendFrame(c: Conn, f: ServerFrame): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(f));
  }

  private presence(): UserPresence[] {
    const users = new Set(this.db.knownUsers());
    for (const u of this.daemons.keys()) users.add(u);
    return [...users].sort().map((user) => {
      const d = this.daemons.get(user);
      const p: UserPresence = { user, connected: !!d, sessions: this.db.sessionsFor(user) };
      if (d?.ip) p.hub_address = d.ip;
      return p;
    });
  }

  // --------------------------------------------------------------- websocket
  private onSocket(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = { ws, authed: false, lastSeen: Date.now(), ip: req.socket.remoteAddress?.replace(/^::ffff:/, "") };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.authed) this.authFail(conn, "no hello within timeout");
    }, this.opts.helloTimeoutMs ?? 5_000);

    ws.on("message", (data) => {
      conn.lastSeen = Date.now();
      let frame: ClientFrame;
      try {
        frame = JSON.parse(data.toString());
        if (!frame || typeof frame !== "object" || typeof (frame as any).op !== "string") throw new Error("no op");
      } catch {
        if (!conn.authed) return this.authFail(conn, "bad hello");
        return this.sendFrame(conn, { op: "error", code: "bad_frame", message: "invalid JSON frame" });
      }
      try {
        this.onFrame(conn, frame);
      } catch (err) {
        logInfo("frame.error", { error: String(err), op: frame.op });
        this.sendFrame(conn, { op: "error", code: "bad_frame", message: String(err) });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      if (conn.role === "daemon" && conn.user && this.daemons.get(conn.user) === conn) this.daemonGone(conn.user);
    });
    ws.on("error", () => {});
  }

  private authFail(conn: Conn, why: string): void {
    logInfo("auth.failed", { ip: conn.ip, why });
    this.sendFrame(conn, { op: "error", code: "auth_failed", message: why });
    conn.ws.close(4001, "auth failed");
  }

  private onFrame(conn: Conn, f: ClientFrame): void {
    if (!conn.authed) {
      if (f.op !== "hello") return this.authFail(conn, "first frame must be hello");
      return this.onHello(conn, f);
    }
    if (f.op === "ping") return this.sendFrame(conn, { op: "pong" });
    if (f.op === "hello") return this.sendFrame(conn, { op: "error", code: "protocol", message: "already said hello" });
    if (conn.role !== "daemon") {
      return this.sendFrame(conn, { op: "error", code: "protocol", message: `op ${f.op} not allowed for role ${conn.role}` });
    }
    const user = conn.user!;
    switch (f.op) {
      case "send":
        return this.onSend(conn, f.envelope);
      case "ack":
        return this.onAck(user, f.id);
      case "session.upsert":
        return this.onSessionUpsert(conn, f.session);
      case "session.remove": {
        const address = `${user}/${f.agent}`;
        if (this.db.removeSession(address)) this.emit({ type: "session.removed", address });
        return;
      }
      case "heartbeat":
        return this.onHeartbeat(user, f.agents);
      default:
        this.sendFrame(conn, { op: "error", code: "bad_frame", message: `unknown op ${(f as any).op}` });
    }
  }

  private onHello(conn: Conn, f: Extract<ClientFrame, { op: "hello" }>): void {
    if (!tokenMatches(f.token, this.opts.token)) return this.authFail(conn, "bad token");
    if (f.protocol !== PROTOCOL_VERSION) {
      this.sendFrame(conn, { op: "error", code: "protocol", message: `hub speaks protocol ${PROTOCOL_VERSION}` });
      conn.ws.close(4002, "protocol mismatch");
      return;
    }
    if (f.role !== "daemon" && f.role !== "ui") return this.authFail(conn, "bad role");
    if (f.role === "daemon" && (typeof f.user !== "string" || !PART_RE.test(f.user))) return this.authFail(conn, "bad user");
    conn.authed = true;
    conn.role = f.role;
    conn.user = f.user;

    if (f.role === "daemon") {
      const old = this.daemons.get(f.user);
      this.daemons.set(f.user, conn);
      if (old) old.ws.close(4003, "replaced by newer connection");
      this.db.touchUser(f.user);
      logInfo("daemon.connected", { user: f.user, ip: conn.ip, replaced: !!old });
    } else {
      logInfo("ui.connected", { user: f.user, ip: conn.ip });
    }

    this.sendFrame(conn, { op: "welcome", hub_id: this.hubId, hub_name: this.opts.hubName, server_time: new Date().toISOString(), protocol: PROTOCOL_VERSION });
    this.sendFrame(conn, { op: "snapshot", users: this.presence(), context: this.db.listContext(), last_seq: this.seq });
    if (typeof f.since_seq === "number") {
      let since = f.since_seq;
      for (;;) {
        const frames = this.db.eventsSince(since, 500);
        for (const frame of frames) this.sendFrame(conn, { op: "event", frame });
        if (frames.length < 500) break;
        since = frames[frames.length - 1].seq;
      }
    }
    if (f.role === "daemon") {
      // Emitted after welcome/snapshot so the new socket's first frame is always welcome.
      this.emit({ type: "user.connected", user: f.user, hub_address: conn.ip });
      for (const { envelope } of this.db.pendingFor(f.user)) this.sendFrame(conn, { op: "deliver", envelope });
    }
  }

  private daemonGone(user: string): void {
    this.daemons.delete(user);
    logInfo("daemon.disconnected", { user });
    for (const s of this.db.sessionsFor(user)) {
      if (s.status !== "offline") {
        this.db.setOffline(s.address, true);
        this.emit({ type: "session.updated", session: rowToSession(this.db.getSession(s.address)) });
      }
    }
    this.emit({ type: "user.disconnected", user });
  }

  // -------------------------------------------------------------- messaging
  private reject(conn: Conn, env: Partial<Envelope>, reason: "hop_limit" | "bad_address" | "bad_envelope" | "from_mismatch"): void {
    logMsg("msg.rejected", env, { reason });
    this.sendFrame(conn, { op: "rejected", id: typeof env.id === "string" ? env.id : "", reason });
  }

  private drop(env: Envelope, reason: string, existing?: StoredMessage): StoredMessage {
    const at = new Date().toISOString();
    let msg: StoredMessage;
    if (existing) {
      this.db.setMessageState(env.id, "dropped", { drop_reason: reason });
      msg = this.db.getMessage(env.id)!;
    } else {
      msg = this.db.insertMessage(env, "dropped", at, reason);
    }
    logMsg("msg.dropped", env, { reason });
    this.emit({ type: "message.dropped", message: msg });
    return msg;
  }

  private onSend(conn: Conn, env: Envelope): void {
    const e = env as any;
    const shapeOk =
      e && typeof e === "object" && typeof e.id === "string" && e.id.length > 0 && e.id.length <= 128 &&
      MESSAGE_TYPES.includes(e.type) && Number.isInteger(e.hops) && e.hops >= 0 &&
      (typeof e.body === "string" || (e.body && typeof e.body === "object" && !Array.isArray(e.body))) &&
      typeof e.timestamp === "string" && (e.reply_to === null || e.reply_to === undefined || typeof e.reply_to === "string");
    if (!shapeOk) return this.reject(conn, e ?? {}, "bad_envelope");
    const clean: Envelope = {
      id: e.id, from: e.from, to: e.to, reply_to: e.reply_to ?? null, hops: e.hops, type: e.type, body: e.body, timestamp: e.timestamp,
    };

    // Duplicate id: answer the same way as the first time, never re-route.
    const existing = this.db.getMessage(clean.id);
    if (existing) {
      if (existing.state === "dropped") return this.reject(conn, clean, (existing.drop_reason as any) ?? "bad_envelope");
      return this.sendFrame(conn, { op: "accepted", id: clean.id });
    }

    if (!isAgentAddress(clean.from) || !isTarget(clean.to)) {
      this.drop(clean, "bad_address");
      return this.reject(conn, clean, "bad_address");
    }
    if (userOf(clean.from) !== conn.user) return this.reject(conn, clean, "from_mismatch");

    // The hub's delivery is a forward, so the delivered copy carries hops + 1.
    if (clean.hops > HOP_LIMIT || clean.hops + 1 > HOP_LIMIT) {
      this.drop(clean, "hop_limit");
      return this.reject(conn, clean, "hop_limit");
    }

    const msg = this.db.insertMessage(clean, "accepted", new Date().toISOString(), null);
    logMsg("msg.accepted", clean);
    this.sendFrame(conn, { op: "accepted", id: clean.id });
    this.emit({ type: "message.accepted", message: msg });
    this.touchActivity(clean.from);
    this.route(clean);
  }

  private route(env: Envelope): void {
    const sender = userOf(env.from);
    let recipients: string[];
    if (env.to === "*") {
      const users = new Set(this.db.knownUsers());
      for (const u of this.daemons.keys()) users.add(u);
      users.delete(sender);
      recipients = [...users];
    } else {
      recipients = [userOf(env.to)];
    }
    const delivered: Envelope = { ...env, hops: env.hops + 1 };
    for (const user of recipients) {
      this.db.touchUser(user);
      this.db.addDelivery(env.id, user, delivered.hops);
      const d = this.daemons.get(user);
      if (d) this.sendFrame(d, { op: "deliver", envelope: delivered });
    }
  }

  private onAck(user: string, id: string): void {
    if (typeof id !== "string") return;
    const at = new Date().toISOString();
    if (!this.db.ackDelivery(id, user, at)) return;
    const msg = this.db.getMessage(id);
    if (!msg) return;
    const to = msg.to === "*" || msg.to.endsWith("/*") ? `${user}/*` : msg.to;
    logMsg("msg.delivered", { ...toEnvelope(msg), to }, { recipient: user });
    if (this.db.unackedCount(id) === 0) this.db.setMessageState(id, "delivered", { delivered_at: at });
    this.emit({ type: "message.delivered", id, to, at });
    if (isAgentAddress(to)) this.touchActivity(to);
  }

  private touchActivity(address: string): void {
    if (!this.db.getSession(address)) return;
    this.db.bumpActivity(address);
    this.emit({ type: "session.updated", session: rowToSession(this.db.getSession(address)) });
  }

  // ---------------------------------------------------------------- sessions
  private onSessionUpsert(conn: Conn, s: any): void {
    if (!s || !PART_RE.test(s.agent) || !SESSION_KINDS.includes(s.kind) || !SESSION_STATUSES.includes(s.status)) {
      return this.sendFrame(conn, { op: "error", code: "bad_frame", message: "invalid session" });
    }
    const user = conn.user!;
    this.db.upsertSession({ user, agent: s.agent, kind: s.kind, status: s.status, task: typeof s.task === "string" ? s.task : "" }, Date.now());
    this.emit({ type: "session.updated", session: rowToSession(this.db.getSession(`${user}/${s.agent}`)) });
  }

  private onHeartbeat(user: string, agents: unknown): void {
    if (!Array.isArray(agents)) return;
    const now = Date.now();
    for (const agent of agents) {
      if (typeof agent !== "string") continue;
      const address = `${user}/${agent}`;
      const s = this.db.getSession(address);
      if (!s) continue;
      this.db.heartbeat(address, now);
      if (s.offline) {
        this.db.setOffline(address, false);
        this.emit({ type: "session.updated", session: rowToSession(this.db.getSession(address)) });
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    const timeout = this.opts.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    for (const s of this.db.allSessionRows()) {
      if (!s.offline && now - s.last_heartbeat > timeout) {
        this.db.setOffline(s.address, true);
        this.emit({ type: "session.updated", session: rowToSession(this.db.getSession(s.address)) });
      }
    }
    const idle = this.opts.socketIdleMs ?? 45_000;
    for (const c of this.conns) if (now - c.lastSeen > idle) c.ws.terminate();
  }

  // ----------------------------------------------------------------- context
  putContext(key: string, w: ContextWrite): { status: number; body: unknown } {
    if (!KEY_RE.test(key)) return { status: 400, body: { error: "bad_key" } };
    if (!w || typeof w !== "object" || !CONTEXT_KINDS.includes(w.kind)) return { status: 400, body: { error: "bad_kind" } };
    if (typeof w.title !== "string" || typeof w.body !== "string") return { status: 400, body: { error: "bad_body" } };
    if (!isAgentAddress(w.author)) return { status: 400, body: { error: "bad_author" } };
    const current = this.db.getContext(key);
    if (w.base_version !== undefined && w.base_version !== (current?.version ?? 0)) {
      return { status: 409, body: { error: "conflict", current } };
    }
    const entry: ContextEntry = {
      key, title: w.title, kind: w.kind, body: w.body, author: w.author,
      version: (current?.version ?? 0) + 1, updated_at: new Date().toISOString(),
    };
    this.db.putContext(entry);
    this.emit({ type: "context.updated", entry });
    this.notifyContext(entry);
    return { status: 200, body: entry };
  }

  deleteContext(key: string, author: string): boolean {
    if (!this.db.deleteContext(key)) return false;
    this.emit({ type: "context.deleted", key, author });
    return true;
  }

  /** Every connected daemon gets a context_update delivery that it must ack. */
  private notifyContext(entry: ContextEntry): void {
    for (const [user, d] of this.daemons) {
      const env: Envelope = {
        id: randomUUID(), from: entry.author, to: `${user}/*`, reply_to: null, hops: 0, type: "context_update",
        body: { text: `${entry.title} updated`, context_key: entry.key }, timestamp: new Date().toISOString(),
      };
      const msg = this.db.insertMessage(env, "accepted", env.timestamp, null);
      logMsg("msg.accepted", env);
      this.emit({ type: "message.accepted", message: msg });
      this.db.addDelivery(env.id, user, 1);
      this.sendFrame(d, { op: "deliver", envelope: { ...env, hops: 1 } });
    }
  }

  // -------------------------------------------------------------------- REST
  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
    const url = new URL(req.url ?? "/", "http://hub");
    const path = url.pathname;
    const send = (status: number, body?: unknown) => {
      if (body === undefined) {
        res.writeHead(status).end();
      } else {
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      }
    };
    if (req.method === "OPTIONS") return send(204);
    if (!path.startsWith("/api/")) return send(404, { error: "not_found" });
    if (path === "/api/health" && req.method === "GET") {
      return send(200, { ok: true, hub_id: this.hubId, hub_name: this.opts.hubName, protocol: PROTOCOL_VERSION });
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokenMatches(auth.slice(7), this.opts.token)) return send(401, { error: "unauthorized" });

    try {
      const q = url.searchParams;
      let m: RegExpMatchArray | null;
      if (path === "/api/sessions" && req.method === "GET") return send(200, { users: this.presence() });
      if (path === "/api/messages" && req.method === "GET") {
        const limit = clampInt(q.get("limit"), 50, 1, 500);
        return send(200, {
          messages: this.db.queryMessages({ address: q.get("address") || undefined, with: q.get("with") || undefined, limit, before: q.get("before") || undefined }),
        });
      }
      if ((m = path.match(/^\/api\/messages\/([^/]+)$/)) && req.method === "GET") {
        const msg = this.db.getMessage(decodeURIComponent(m[1]));
        return msg ? send(200, msg) : send(404, { error: "not_found" });
      }
      if (path === "/api/context" && req.method === "GET") return send(200, { entries: this.db.listContext(q.get("q") || undefined) });
      if ((m = path.match(/^\/api\/context\/([^/]+)$/))) {
        const key = decodeURIComponent(m[1]);
        if (req.method === "GET") {
          const e = this.db.getContext(key);
          return e ? send(200, e) : send(404, { error: "not_found" });
        }
        if (req.method === "PUT") {
          let body: ContextWrite;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return send(400, { error: "bad_json" });
          }
          const r = this.putContext(key, body);
          return send(r.status, r.body);
        }
        if (req.method === "DELETE") {
          return this.deleteContext(key, q.get("author") ?? "") ? send(204) : send(404, { error: "not_found" });
        }
      }
      if (path === "/api/events" && req.method === "GET") {
        const since = clampInt(q.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
        return send(200, { frames: this.db.eventsSince(since, clampInt(q.get("limit"), 200, 1, 1000)) });
      }
      return send(404, { error: "not_found" });
    } catch (err) {
      logInfo("http.error", { path, error: String(err) });
      return send(500, { error: "internal" });
    }
  }
}

/** Constant-time token check; hashing first makes the lengths equal so timingSafeEqual can't throw. */
function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(given), h(expected));
}

function clampInt(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
