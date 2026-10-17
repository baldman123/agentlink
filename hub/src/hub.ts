import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  ADDRESS_RE,
  HOP_LIMIT,
  PROTOCOL_VERSION,
  SCREEN_MAX_BYTES,
  SESSION_TIMEOUT_MS,
  type ClientFrame,
  type ClientRole,
  type ContextEntry,
  type ContextWrite,
  type Envelope,
  type EventFrame,
  type HubEvent,
  type MessageType,
  type ScreenInfo,
  type ScreenUpdate,
  type ServerFrame,
  type SessionKind,
  type SessionStatus,
  type StoredMessage,
  type UserPresence,
} from "../../contracts/index.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { clientProof, newNonce, personalToken, safeEqualHex, serverProof, validCnonce } from "./auth.ts";
import { CONTEXT_KINDS, HubDb, rowToSession, toEnvelope } from "./db.ts";
import { logInfo, logMsg } from "./log.ts";

export interface HubOptions {
  port: number;
  host?: string;
  token: string; // the master token: the HMAC key for `owner` only, and the root of every personal token
  owner: string; // the hub owner's user (AGENTLINK_HUB_OWNER); "" = no one may use the master token
  dbPath: string;
  hubName: string;
  helloTimeoutMs?: number;
  socketIdleMs?: number;
  sweepIntervalMs?: number;
  sessionTimeoutMs?: number;
  restSessionGraceMs?: number; // how long a REST session outlives its socket (default 60s)
}

interface Conn {
  ws: WebSocket;
  authed: boolean;
  nonce: string | null; // this socket's challenge nonce; null once a hello has used it (single use)
  session?: string; // REST bearer handed out in welcome
  role?: ClientRole;
  user?: string;
  ip?: string;
  lastSeen: number;
  screenSubs?: Set<string> | "*"; // ui only: addresses whose screens this socket gets
}

const SCREEN_MAX_DIM = 2000; // cols/rows sanity bound
const SCREEN_MAX_SUBS = 500;
interface StoredScreen {
  screen: ScreenUpdate;
  at: string;
}

const PART_RE = /^[a-z0-9_-]{1,32}$/;
const KEY_RE = /^[a-z0-9._-]{1,64}$/;
const MESSAGE_TYPES: MessageType[] = ["task", "result", "chat", "context_update", "status"];
const SESSION_KINDS: SessionKind[] = ["orchestrator", "worker", "human"];
const SESSION_STATUSES: SessionStatus[] = ["idle", "working", "waiting", "error", "offline"];

const userOf = (addr: string) => addr.split("/")[0];
/** What a user may read: messages from or to that user, and broadcasts to "*". */
const canSee = (user: string | undefined, m: { from: string; to: string } | null) =>
  !!user && !!m && (userOf(m.from) === user || m.to === "*" || userOf(m.to) === user);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
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
  // Latest terminal screen per address. Memory only: never in SQLite or the event log (screens.md).
  private screens = new Map<string, StoredScreen>();
  private screenRejectLogged = new Map<string, number>();
  // REST sessions (v2): bearer -> its socket; valid while the socket is open, then for restSessionGraceMs.
  private restSessions = new Map<string, { conn: Conn; expiresAt: number | null }>();

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
    const msg = this.eventMessage(event);
    for (const c of this.conns) if (c.authed && (msg === undefined || canSee(c.user, msg))) this.sendFrame(c, { op: "event", frame });
    // Every path that takes a session offline or removes it ends up here, so screens are dropped here.
    if (event.type === "session.updated" && event.session.status === "offline") this.dropScreen(event.session.address);
    if (event.type === "session.removed") this.dropScreen(event.address);
    return frame;
  }

  /**
   * The message a message.* event is about (null if it no longer exists), or undefined for any other event.
   * Message events go only to users who can see that message; everything else (sessions, context, users) is shared.
   */
  private eventMessage(event: HubEvent): { from: string; to: string } | null | undefined {
    if (event.type === "message.accepted" || event.type === "message.dropped") return event.message;
    if (event.type === "message.delivered") return this.db.getMessage(event.id);
    return undefined;
  }

  private eventsFor(user: string | undefined, since: number, limit: number): EventFrame[] {
    return this.db.eventsSince(since, limit).filter((f) => {
      const msg = this.eventMessage(f.event);
      return msg === undefined || canSee(user, msg);
    });
  }

  // ------------------------------------------------------------------ people
  /** The HMAC key for this user's proofs: the master token for the owner, a personal token for an invited person, else null. */
  private keyFor(user: string): string | null {
    if (this.opts.owner && user === this.opts.owner) return this.opts.token;
    const p = this.db.getPerson(user);
    return p && !p.revoked_at ? personalToken(this.opts.token, user, p.epoch) : null;
  }

  private allowed(user: string): boolean {
    return this.keyFor(user) !== null;
  }

  /** Invites `user` (or re-invites: the earlier token stops working and their sockets are closed). Returns the personal token. */
  invite(user: string): { token: string; epoch: number; reinvited: boolean } {
    if (!PART_RE.test(user)) throw new Error("bad user");
    if (user === this.opts.owner) throw new Error("owner");
    const had = this.db.getPerson(user);
    const row = this.db.invitePerson(user);
    if (had) this.kick(user, "re-invited; the old token no longer works");
    logInfo("person.invited", { user, epoch: row.epoch, reinvited: !!had });
    return { token: personalToken(this.opts.token, user, row.epoch), epoch: row.epoch, reinvited: !!had };
  }

  /** Revokes `user`: their token stops working and every socket and REST session of theirs ends now. */
  revoke(user: string): boolean {
    if (!this.db.revokePerson(user)) return false;
    this.kick(user, "access revoked");
    logInfo("person.revoked", { user });
    return true;
  }

  private kick(user: string, why: string): void {
    for (const c of this.conns) {
      if (c.user !== user) continue;
      this.sendFrame(c, { op: "error", code: "auth_failed", message: why });
      c.ws.close(4001, why);
    }
    for (const [bearer, s] of this.restSessions) if (s.conn.user === user) this.restSessions.delete(bearer);
  }

  private sendFrame(c: Conn, f: ServerFrame): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(f));
  }

  private presence(): UserPresence[] {
    // Revoked and never-invited users drop out of the list (their old sessions stay in the db).
    const users = new Set(this.db.knownUsers().filter((u) => this.allowed(u)));
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
    const conn: Conn = { ws, authed: false, nonce: newNonce(), lastSeen: Date.now(), ip: req.socket.remoteAddress?.replace(/^::ffff:/, "") };
    this.conns.add(conn);
    const helloTimer = setTimeout(() => {
      if (!conn.authed) this.authFail(conn, "no hello within timeout");
    }, this.opts.helloTimeoutMs ?? 5_000);
    // v2: the first frame on every socket. The client checks hub_id against its pin before answering.
    this.sendFrame(conn, { op: "challenge", nonce: conn.nonce!, hub_id: this.hubId, hub_name: this.opts.hubName, protocol: PROTOCOL_VERSION });

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
      conn.nonce = null;
      const s = conn.session ? this.restSessions.get(conn.session) : undefined;
      if (s) s.expiresAt = Date.now() + (this.opts.restSessionGraceMs ?? 60_000);
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
    if (f.op === "screens.subscribe") {
      if (conn.role !== "ui") return this.sendFrame(conn, { op: "error", code: "protocol", message: "screens.subscribe is for ui sockets" });
      return this.onScreensSubscribe(conn, f.addresses);
    }
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
      case "screen":
        return this.onScreen(conn, f.screen);
      default:
        this.sendFrame(conn, { op: "error", code: "bad_frame", message: `unknown op ${(f as any).op}` });
    }
  }

  private onHello(conn: Conn, f: Extract<ClientFrame, { op: "hello" }>): void {
    // The nonce is single use: whatever this hello turns out to be, it can't be answered again.
    const nonce = conn.nonce;
    conn.nonce = null;
    const h = f as Record<string, unknown>;
    // A v1 client puts the shared token in hello. Refuse it without looking at it (never logged, never compared).
    if ("token" in h) return this.authFail(conn, "protocol 1 hello (token field) refused; upgrade to protocol 2");
    if (typeof f.protocol !== "number" || f.protocol < PROTOCOL_VERSION) return this.authFail(conn, `protocol ${String(f.protocol)} refused; hub speaks ${PROTOCOL_VERSION}`);
    if (f.protocol !== PROTOCOL_VERSION) {
      this.sendFrame(conn, { op: "error", code: "protocol", message: `hub speaks protocol ${PROTOCOL_VERSION}` });
      conn.ws.close(4002, "protocol mismatch");
      return;
    }
    if (!nonce) return this.authFail(conn, "no challenge outstanding");
    if (f.role !== "daemon" && f.role !== "ui") return this.authFail(conn, "bad role");
    if (typeof f.user !== "string" || !PART_RE.test(f.user)) return this.authFail(conn, "bad user");
    if (!validCnonce(f.cnonce)) return this.authFail(conn, "bad cnonce");
    // The key depends on who the hello claims to be, so a token only ever works for its own user:
    // the master token for the owner, a personal token for that one invited person.
    const key = this.keyFor(f.user);
    if (!key) {
      logInfo("auth.failed", { ip: conn.ip, why: "user not invited or revoked", user: f.user });
      return this.authFail(conn, "bad proof");
    }
    if (!safeEqualHex(f.proof, clientProof(key, nonce, this.hubId, f.user, f.role, f.cnonce))) {
      return this.authFail(conn, "bad proof");
    }
    conn.authed = true;
    conn.role = f.role;
    conn.user = f.user;
    conn.session = newNonce();
    this.restSessions.set(conn.session, { conn, expiresAt: null });

    if (f.role === "daemon") {
      const old = this.daemons.get(f.user);
      this.daemons.set(f.user, conn);
      if (old) old.ws.close(4003, "replaced by newer connection");
      this.db.touchUser(f.user);
      logInfo("daemon.connected", { user: f.user, ip: conn.ip, replaced: !!old });
    } else {
      logInfo("ui.connected", { user: f.user, ip: conn.ip });
    }

    this.sendFrame(conn, {
      op: "welcome",
      hub_id: this.hubId,
      hub_name: this.opts.hubName,
      server_time: new Date().toISOString(),
      protocol: PROTOCOL_VERSION,
      server_proof: serverProof(key, f.cnonce, nonce, this.hubId),
      session: conn.session,
    });
    this.sendFrame(conn, { op: "snapshot", users: this.presence(), context: this.db.listContext(), last_seq: this.seq });
    if (typeof f.since_seq === "number") {
      let since = f.since_seq;
      for (;;) {
        const frames = this.db.eventsSince(since, 500);
        for (const frame of frames) {
          const msg = this.eventMessage(frame.event);
          if (msg === undefined || canSee(f.user, msg)) this.sendFrame(conn, { op: "event", frame });
        }
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
      const users = new Set(this.db.knownUsers().filter((u) => this.allowed(u)));
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

  // ----------------------------------------------------------------- screens
  private onScreen(conn: Conn, s: any): void {
    const user = conn.user!;
    const reject = (why: string) => {
      // a bridge may retry twice a second; log each (user, agent, reason) at most once a minute
      const agent = typeof s?.agent === "string" ? s.agent.slice(0, 64) : null;
      const key = `${user}|${agent}|${why}`;
      const now = Date.now();
      if ((this.screenRejectLogged.get(key) ?? 0) < now - 60_000) {
        this.screenRejectLogged.set(key, now);
        if (this.screenRejectLogged.size > 1000) this.screenRejectLogged.clear();
        logInfo("screen.rejected", { user, agent, why });
      }
      this.sendFrame(conn, { op: "error", code: "bad_frame", message: `screen rejected: ${why}` });
    };
    // PART_RE has no "/", so the agent can only ever name a session of this daemon's own user.
    if (!s || typeof s !== "object" || typeof s.agent !== "string" || !PART_RE.test(s.agent)) return reject("bad agent");
    if (typeof s.text !== "string") return reject("bad text");
    if (Buffer.byteLength(s.text, "utf8") > SCREEN_MAX_BYTES) return reject(`text over ${SCREEN_MAX_BYTES} bytes`);
    const dim = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= SCREEN_MAX_DIM;
    if (!dim(s.cols) || !dim(s.rows)) return reject("bad cols/rows");
    const address = `${user}/${s.agent}`;
    const session = this.db.getSession(address);
    if (!session) return reject("no session");
    if (session.offline) return reject("session offline");

    const screen: ScreenUpdate = { agent: s.agent, text: s.text, cols: s.cols, rows: s.rows, busy: s.busy === true };
    const prev = this.screens.get(address)?.screen;
    if (prev && prev.text === screen.text && prev.cols === screen.cols && prev.rows === screen.rows && prev.busy === screen.busy) return;
    const stored: StoredScreen = { screen, at: new Date().toISOString() };
    this.screens.set(address, stored);
    for (const c of this.conns) if (this.wantsScreen(c, address)) this.sendFrame(c, { op: "screen", address, ...stored });
  }

  private onScreensSubscribe(conn: Conn, addresses: unknown): void {
    if (addresses === "*") {
      conn.screenSubs = "*";
    } else if (Array.isArray(addresses) && addresses.length <= SCREEN_MAX_SUBS && addresses.every(isAgentAddress)) {
      conn.screenSubs = new Set(addresses);
    } else {
      return this.sendFrame(conn, { op: "error", code: "bad_frame", message: `addresses must be "*" or up to ${SCREEN_MAX_SUBS} user/agent addresses` });
    }
    for (const [address, stored] of this.screens) {
      if (this.wantsScreen(conn, address)) this.sendFrame(conn, { op: "screen", address, ...stored });
    }
  }

  private wantsScreen(c: Conn, address: string): boolean {
    if (!c.authed || c.role !== "ui" || !c.screenSubs) return false; // daemons never get screens
    return c.screenSubs === "*" || c.screenSubs.has(address);
  }

  private dropScreen(address: string): void {
    if (!this.screens.delete(address)) return;
    for (const c of this.conns) if (this.wantsScreen(c, address)) this.sendFrame(c, { op: "screen.gone", address });
  }

  screenInfos(): ScreenInfo[] {
    return [...this.screens].map(([address, { screen, at }]) => ({ address, cols: screen.cols, rows: screen.rows, at }));
  }

  private restSessionValid(bearer: string): boolean {
    const s = this.restSessions.get(bearer);
    if (!s) return false;
    if (s.expiresAt !== null && Date.now() >= s.expiresAt) {
      this.restSessions.delete(bearer);
      return false;
    }
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [bearer, s] of this.restSessions) if (s.expiresAt !== null && now >= s.expiresAt) this.restSessions.delete(bearer);
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
  private landingPage(): string {
    return renderLanding(this.opts.hubName, this.daemons.size);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://hub").pathname.startsWith("/api/admin/")) return this.handleAdmin(req, res);
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
    if (path === "/" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return void res.end(req.method === "HEAD" ? undefined : this.landingPage());
    }
    if (!path.startsWith("/api/")) return send(404, { error: "not_found" });
    if (path === "/api/health" && req.method === "GET") {
      return send(200, { ok: true, hub_id: this.hubId, hub_name: this.opts.hubName, protocol: PROTOCOL_VERSION });
    }
    const auth = req.headers.authorization ?? "";
    // v2: only a session from a live (or just closed) socket's welcome. The master token itself gets 401.
    if (!auth.startsWith("Bearer ") || !this.restSessionValid(auth.slice(7))) return send(401, { error: "unauthorized" });
    // Reads of messages are scoped to the user whose socket this session came from.
    const viewer = this.restSessions.get(auth.slice(7))!.conn.user!;

    try {
      const q = url.searchParams;
      let m: RegExpMatchArray | null;
      if (path === "/api/sessions" && req.method === "GET") return send(200, { users: this.presence() });
      if (path === "/api/screens" && req.method === "GET") return send(200, { screens: this.screenInfos() });
      if (path === "/api/messages" && req.method === "GET") {
        const limit = clampInt(q.get("limit"), 50, 1, 500);
        return send(200, {
          messages: this.db.queryMessages({ address: q.get("address") || undefined, with: q.get("with") || undefined, limit, before: q.get("before") || undefined, viewer }),
        });
      }
      if ((m = path.match(/^\/api\/messages\/([^/]+)$/)) && req.method === "GET") {
        const msg = this.db.getMessage(decodeURIComponent(m[1]));
        return msg && canSee(viewer, msg) ? send(200, msg) : send(404, { error: "not_found" });
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
        return send(200, { frames: this.eventsFor(viewer, since, clampInt(q.get("limit"), 200, 1, 1000)) });
      }
      return send(404, { error: "not_found" });
    } catch (err) {
      logInfo("http.error", { path, error: String(err) });
      return send(500, { error: "internal" });
    }
  }

  /**
   * People admin for `bin/agentlink-hub`: only from this machine (loopback) and only with the master token,
   * as `Authorization: Admin <master>`. No CORS headers, so no web page can call it.
   */
  private async handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      logInfo("admin.refused", { ip: req.socket.remoteAddress, why: "not loopback" });
      return send(403, { error: "loopback_only" });
    }
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Admin ") || !timingSafeEqual(sha256(auth.slice(6)), sha256(this.opts.token))) {
      logInfo("admin.refused", { why: "bad master token" });
      return send(401, { error: "unauthorized" });
    }
    const path = new URL(req.url ?? "/", "http://hub").pathname;
    let m: RegExpMatchArray | null;
    try {
      if (path === "/api/admin/people" && req.method === "GET") {
        const online = new Set([...this.conns].filter((c) => c.authed).map((c) => c.user));
        return send(200, {
          hub_id: this.hubId,
          hub_name: this.opts.hubName,
          owner: this.opts.owner,
          people: this.db.listPeople().map((p) => ({ ...p, connected: online.has(p.user) })),
        });
      }
      if (path === "/api/admin/people" && req.method === "POST") {
        let body: { user?: unknown };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(400, { error: "bad_json" });
        }
        const user = typeof body?.user === "string" ? body.user : "";
        if (!PART_RE.test(user)) return send(400, { error: "bad_user", detail: "lowercase letters, digits, - or _; up to 32" });
        if (user === this.opts.owner) return send(400, { error: "owner", detail: `${user} is the hub owner and uses the master token` });
        return send(200, { user, hub_id: this.hubId, ...this.invite(user) });
      }
      if ((m = path.match(/^\/api\/admin\/people\/([^/]+)\/revoke$/)) && req.method === "POST") {
        const user = decodeURIComponent(m[1]);
        return this.revoke(user) ? send(200, { ok: true, user }) : send(404, { error: "not_found", detail: `${user} is not an active invitee` });
      }
      return send(404, { error: "not_found" });
    } catch (err) {
      logInfo("http.error", { path, error: String(err) });
      return send(500, { error: "internal" });
    }
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Public page for someone who opens the hub URL in a browser. No token, no session details. */
function renderLanding(hubName: string, connectedUsers: number): string {
  const name = escapeHtml(hubName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentlink hub · ${name}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111418; color: #d8dde3;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 560px; width: 100%; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; color: #f2f4f7; }
  .meta { color: #8b95a1; font-size: 14px; margin: 0 0 24px; }
  .note { background: #1a1f25; border: 1px solid #2a313a; border-radius: 8px; padding: 16px 18px; }
  .note p { margin: 0 0 8px; } .note p:last-child { margin: 0; }
  code { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; color: #9ecbff; word-break: break-all; }
</style></head>
<body><main>
  <h1>agentlink hub · ${name}</h1>
  <p class="meta">protocol v${PROTOCOL_VERSION} · ${connectedUsers} user${connectedUsers === 1 ? "" : "s"} connected</p>
  <div class="note">
    <p><strong>This is the hub, not the app.</strong></p>
    <p>Open the app on your own laptop at <code>http://127.0.0.1:7780/?daemon=&lt;your daemon port&gt;</code> after starting your daemon pointed at this hub.</p>
  </div>
</main></body></html>
`;
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
