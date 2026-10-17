import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ContextEntry,
  ContextKind,
  DeliveryState,
  Envelope,
  EventFrame,
  HubEvent,
  Session,
  SessionKind,
  SessionStatus,
  StoredMessage,
} from "../../contracts/index.ts";

export interface DeliveryRow {
  message_id: string;
  user: string;
  acked: number;
  hops: number; // hops value of the delivered copy
}

export interface PersonRow {
  user: string;
  epoch: number;
  created_at: string;
  invited_at: string;
  revoked_at: string | null;
}

export class HubDb {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        reply_to TEXT,
        hops INTEGER NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        state TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        delivered_at TEXT,
        drop_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_from ON messages(from_addr);
      CREATE INDEX IF NOT EXISTS messages_to ON messages(to_addr);
      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL,
        user TEXT NOT NULL,
        hops INTEGER NOT NULL,
        acked INTEGER NOT NULL DEFAULT 0,
        acked_at TEXT,
        seq INTEGER NOT NULL,
        PRIMARY KEY (message_id, user)
      );
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(user, acked, seq);
      CREATE TABLE IF NOT EXISTS users (user TEXT PRIMARY KEY, first_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        address TEXT PRIMARY KEY,
        user TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        offline INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS context (
        key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        event TEXT NOT NULL
      );
      -- People invited to this hub (everyone but the owner). Their token is derived from the master
      -- token and the epoch (auth.ts personalToken), so no secret is stored here.
      CREATE TABLE IF NOT EXISTS people (
        user TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        invited_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
  }

  // ---- meta ----
  hubId(): string {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'hub_id'").get() as { v: string } | undefined;
    if (row) return row.v;
    const id = randomUUID();
    this.db.prepare("INSERT INTO meta (k, v) VALUES ('hub_id', ?)").run(id);
    return id;
  }

  // ---- events ----
  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    return row.s ?? 0;
  }

  insertEvent(seq: number, at: string, event: HubEvent): void {
    this.db.prepare("INSERT INTO events (seq, at, event) VALUES (?, ?, ?)").run(seq, at, JSON.stringify(event));
  }

  eventsSince(since: number, limit: number): EventFrame[] {
    const rows = this.db
      .prepare("SELECT seq, at, event FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(since, limit) as { seq: number; at: string; event: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.event) }));
  }

  // ---- messages ----
  getMessage(id: string): StoredMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? rowToMessage(row) : null;
  }

  insertMessage(env: Envelope, state: DeliveryState, at: string, dropReason: string | null): StoredMessage {
    this.db
      .prepare(
        `INSERT INTO messages (id, from_addr, to_addr, reply_to, hops, type, body, timestamp, state, accepted_at, delivered_at, drop_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(env.id, env.from, env.to, env.reply_to, env.hops, env.type, JSON.stringify(env.body), env.timestamp, state, at, dropReason);
    return this.getMessage(env.id)!;
  }

  setMessageState(id: string, state: DeliveryState, opts: { delivered_at?: string; drop_reason?: string } = {}): void {
    this.db
      .prepare("UPDATE messages SET state = ?, delivered_at = COALESCE(?, delivered_at), drop_reason = COALESCE(?, drop_reason) WHERE id = ?")
      .run(state, opts.delivered_at ?? null, opts.drop_reason ?? null, id);
  }

  /** `viewer`: only messages from or to that user, plus broadcasts to "*". */
  queryMessages(q: { address?: string; with?: string; limit: number; before?: string; viewer?: string }): StoredMessage[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.viewer !== undefined) {
      const prefix = `${q.viewer}/`;
      params.push(prefix, prefix);
      where.push("(instr(from_addr, ?) = 1 OR instr(to_addr, ?) = 1 OR to_addr = '*')");
    }
    const reaches = (addr: string) => {
      const user = addr.split("/")[0];
      params.push(addr, `${user}/*`);
      return `(to_addr = ? OR to_addr = ? OR to_addr = '*')`;
    };
    if (q.address && q.with) {
      const a1 = (params.push(q.address), "from_addr = ?");
      const r1 = reaches(q.with);
      const a2 = (params.push(q.with), "from_addr = ?");
      const r2 = reaches(q.address);
      where.push(`((${a1} AND ${r1}) OR (${a2} AND ${r2}))`);
    } else if (q.address) {
      params.push(q.address);
      where.push(`(from_addr = ? OR ${reaches(q.address)})`);
    }
    if (q.before) {
      where.push("accepted_at < ?");
      params.push(q.before);
    }
    params.push(q.limit);
    const sql = `SELECT * FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY accepted_at DESC, rowid DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params).map(rowToMessage);
  }

  // ---- deliveries ----
  private deliverySeq = 0;

  addDelivery(messageId: string, user: string, hops: number): void {
    if (!this.deliverySeq) {
      const r = this.db.prepare("SELECT MAX(seq) AS s FROM deliveries").get() as { s: number | null };
      this.deliverySeq = r.s ?? 0;
    }
    this.db
      .prepare("INSERT OR IGNORE INTO deliveries (message_id, user, hops, acked, seq) VALUES (?, ?, ?, 0, ?)")
      .run(messageId, user, hops, ++this.deliverySeq);
  }

  pendingFor(user: string): { envelope: Envelope }[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, d.hops AS d_hops FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.user = ? AND d.acked = 0 ORDER BY d.seq ASC`,
      )
      .all(user) as any[];
    return rows.map((r) => ({ envelope: { ...toEnvelope(rowToMessage(r)), hops: r.d_hops } }));
  }

  /** Marks a delivery acked. Returns true if it was pending. */
  ackDelivery(messageId: string, user: string, at: string): boolean {
    const res = this.db
      .prepare("UPDATE deliveries SET acked = 1, acked_at = ? WHERE message_id = ? AND user = ? AND acked = 0")
      .run(at, messageId, user);
    return Number(res.changes) > 0;
  }

  unackedCount(messageId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ? AND acked = 0").get(messageId) as { n: number };
    return r.n;
  }

  // ---- users ----
  touchUser(user: string): void {
    this.db.prepare("INSERT OR IGNORE INTO users (user, first_seen) VALUES (?, ?)").run(user, new Date().toISOString());
  }

  knownUsers(): string[] {
    return (this.db.prepare("SELECT user FROM users ORDER BY user").all() as { user: string }[]).map((r) => r.user);
  }

  // ---- people ----
  getPerson(user: string): PersonRow | null {
    return (this.db.prepare("SELECT * FROM people WHERE user = ?").get(user) as PersonRow | undefined) ?? null;
  }

  listPeople(): PersonRow[] {
    return this.db.prepare("SELECT * FROM people ORDER BY user").all() as unknown as PersonRow[];
  }

  /** Invites `user`, or re-invites them with the next epoch (which kills any earlier token). Returns the new row. */
  invitePerson(user: string): PersonRow {
    const now = new Date().toISOString();
    const cur = this.getPerson(user);
    if (cur) this.db.prepare("UPDATE people SET epoch = ?, invited_at = ?, revoked_at = NULL WHERE user = ?").run(cur.epoch + 1, now, user);
    else this.db.prepare("INSERT INTO people (user, epoch, created_at, invited_at, revoked_at) VALUES (?, 1, ?, ?, NULL)").run(user, now, now);
    return this.getPerson(user)!;
  }

  /** Returns false if the user was never invited or is already revoked. */
  revokePerson(user: string): boolean {
    const res = this.db.prepare("UPDATE people SET revoked_at = ? WHERE user = ? AND revoked_at IS NULL").run(new Date().toISOString(), user);
    return Number(res.changes) > 0;
  }

  // ---- sessions ----
  getSession(address: string): (Session & { offline: number; last_heartbeat: number }) | null {
    const r = this.db.prepare("SELECT * FROM sessions WHERE address = ?").get(address) as any;
    return r ?? null;
  }

  upsertSession(s: { user: string; agent: string; kind: SessionKind; status: SessionStatus; task: string }, now: number): void {
    const address = `${s.user}/${s.agent}`;
    this.db
      .prepare(
        `INSERT INTO sessions (address, user, agent, kind, status, task, last_activity, last_heartbeat, offline)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(address) DO UPDATE SET kind = excluded.kind, status = excluded.status, task = excluded.task,
           last_activity = excluded.last_activity, last_heartbeat = excluded.last_heartbeat, offline = 0`,
      )
      .run(address, s.user, s.agent, s.kind, s.status, s.task, new Date(now).toISOString(), now);
  }

  removeSession(address: string): boolean {
    return Number(this.db.prepare("DELETE FROM sessions WHERE address = ?").run(address).changes) > 0;
  }

  heartbeat(address: string, now: number): void {
    this.db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE address = ?").run(now, address);
  }

  setOffline(address: string, offline: boolean): void {
    this.db.prepare("UPDATE sessions SET offline = ? WHERE address = ?").run(offline ? 1 : 0, address);
  }

  bumpActivity(address: string): void {
    this.db.prepare("UPDATE sessions SET last_activity = ? WHERE address = ?").run(new Date().toISOString(), address);
  }

  sessionsFor(user: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE user = ? ORDER BY agent").all(user) as any[]).map(rowToSession);
  }

  allSessionRows(): (Session & { offline: number; last_heartbeat: number })[] {
    return this.db.prepare("SELECT * FROM sessions").all() as any[];
  }

  // ---- context ----
  getContext(key: string): ContextEntry | null {
    return (this.db.prepare("SELECT * FROM context WHERE key = ?").get(key) as ContextEntry | undefined) ?? null;
  }

  listContext(q?: string): ContextEntry[] {
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      return this.db
        .prepare(
          "SELECT * FROM context WHERE lower(key) LIKE ? OR lower(title) LIKE ? OR lower(body) LIKE ? ORDER BY updated_at DESC",
        )
        .all(like, like, like) as unknown as ContextEntry[];
    }
    return this.db.prepare("SELECT * FROM context ORDER BY updated_at DESC").all() as unknown as ContextEntry[];
  }

  putContext(e: ContextEntry): void {
    this.db
      .prepare(
        `INSERT INTO context (key, title, kind, body, author, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, kind = excluded.kind, body = excluded.body,
           author = excluded.author, version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(e.key, e.title, e.kind, e.body, e.author, e.version, e.updated_at);
  }

  deleteContext(key: string): boolean {
    return Number(this.db.prepare("DELETE FROM context WHERE key = ?").run(key).changes) > 0;
  }
}

export function rowToSession(r: any): Session {
  return {
    address: r.address,
    user: r.user,
    agent: r.agent,
    kind: r.kind,
    status: r.offline ? "offline" : r.status,
    task: r.task,
    last_activity: r.last_activity,
  };
}

function rowToMessage(r: any): StoredMessage {
  return {
    id: r.id,
    from: r.from_addr,
    to: r.to_addr,
    reply_to: r.reply_to ?? null,
    hops: r.hops,
    type: r.type,
    body: JSON.parse(r.body),
    timestamp: r.timestamp,
    state: r.state,
    accepted_at: r.accepted_at,
    delivered_at: r.delivered_at ?? null,
    drop_reason: r.drop_reason ?? null,
  };
}

export function toEnvelope(m: StoredMessage): Envelope {
  return { id: m.id, from: m.from, to: m.to, reply_to: m.reply_to, hops: m.hops, type: m.type, body: m.body, timestamp: m.timestamp };
}

export const CONTEXT_KINDS: ContextKind[] = ["note", "decision", "api_spec"];
