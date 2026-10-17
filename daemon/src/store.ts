import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Envelope, InboxItem, OutboxItem, Session, SessionKind, SessionStatus, UploadResult } from "../../contracts/index.ts";

// Durable state for one daemon: outbox, inbox, local sessions, and a small key/value table.
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string, private user: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        envelope TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        envelope TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        received_at TEXT NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0,
        remote INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_to ON inbox(to_addr);
      CREATE TABLE IF NOT EXISTS sessions (
        agent TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        task TEXT NOT NULL,
        last_activity TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        mime TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  // ---- uploads (uploads.md): files stored on this laptop, uploaded here or downloaded from the hub ----
  uploadInsert(u: UploadResult) {
    this.db
      .prepare("INSERT OR REPLACE INTO uploads (id, name, path, size, sha256, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(u.id, u.name, u.path, u.size, u.sha256, u.mime ?? null, u.created_at);
  }
  /** The stored file, or null when unknown or deleted from disk since. */
  uploadGet(id: string): UploadResult | null {
    const r = this.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as UploadRow | undefined;
    if (!r) return null;
    if (!fs.existsSync(r.path)) {
      this.uploadDelete(id);
      return null;
    }
    return { id: r.id, name: r.name, path: r.path, size: r.size, sha256: r.sha256, created_at: r.created_at, ...(r.mime ? { mime: r.mime } : {}) };
  }
  uploadDelete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM uploads WHERE id = ?").run(id).changes) > 0;
  }

  close() {
    this.db.close();
  }

  // ---- kv ----
  getKv(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return row?.v ?? null;
  }
  setKv(k: string, v: string) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // ---- outbox ----
  enqueue(env: Envelope) {
    this.db
      .prepare("INSERT INTO outbox (id, envelope, next_attempt_at) VALUES (?, ?, ?)")
      .run(env.id, JSON.stringify(env), new Date().toISOString());
  }
  outboxAll(): OutboxItem[] {
    const rows = this.db.prepare("SELECT * FROM outbox ORDER BY seq").all() as unknown as OutboxRow[];
    return rows.map(rowToOutbox);
  }
  outboxDue(now: string): OutboxItem[] {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY seq")
      .all(now) as unknown as OutboxRow[];
    return rows.map(rowToOutbox);
  }
  outboxGet(id: string): OutboxItem | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as OutboxRow | undefined;
    return row ? rowToOutbox(row) : null;
  }
  markAttempt(id: string, attempts: number, nextAt: string, lastError: string | null) {
    this.db
      .prepare("UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(attempts, nextAt, lastError, id);
  }
  dequeue(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id).changes) > 0;
  }
  outboxDepth(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  }

  // ---- inbox ----
  /** Returns the stored item, or null when the id was already present (duplicate delivery). */
  inboxInsert(env: Envelope): InboxItem | null {
    const remote = env.from.split("/")[0] !== this.user;
    const receivedAt = new Date().toISOString();
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO inbox (id, envelope, to_addr, received_at, remote) VALUES (?, ?, ?, ?, ?)",
      )
      .run(env.id, JSON.stringify(env), env.to, receivedAt, remote ? 1 : 0);
    if (Number(res.changes) === 0) return null;
    return { envelope: env, received_at: receivedAt, handled: false, remote };
  }
  inboxList(q: { agent?: string; unhandled?: boolean; since?: string; limit: number }): InboxItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.agent) {
      where.push("to_addr IN (?, ?, '*')");
      args.push(`${this.user}/${q.agent}`, `${this.user}/*`);
    }
    if (q.unhandled) where.push("handled = 0");
    if (q.since) {
      where.push("received_at > ?");
      args.push(q.since);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // A work queue (unhandled/since) reads oldest first from the start; a plain listing returns the
    // newest `limit` rows. Both come back oldest first.
    const sql =
      q.unhandled || q.since
        ? `SELECT * FROM inbox ${w} ORDER BY seq ASC LIMIT ?`
        : `SELECT * FROM (SELECT * FROM inbox ${w} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`;
    const rows = this.db.prepare(sql).all(...args, q.limit) as unknown as InboxRow[];
    return rows.map(rowToInbox);
  }
  inboxAck(id: string): boolean {
    return Number(this.db.prepare("UPDATE inbox SET handled = 1 WHERE id = ?").run(id).changes) > 0;
  }
  inboxUnhandled(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE handled = 0").get() as { n: number }).n;
  }

  // ---- sessions ----
  sessionUpsert(agent: string, kind: SessionKind, status: SessionStatus, task: string): Session {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (agent, kind, status, task, last_activity) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent) DO UPDATE SET kind = excluded.kind, status = excluded.status,
           task = excluded.task, last_activity = excluded.last_activity`,
      )
      .run(agent, kind, status, task, now);
    return this.toSession({ agent, kind, status, task, last_activity: now });
  }
  sessionTouch(agent: string) {
    this.db.prepare("UPDATE sessions SET last_activity = ? WHERE agent = ?").run(new Date().toISOString(), agent);
  }
  sessionRemove(agent: string): boolean {
    return Number(this.db.prepare("DELETE FROM sessions WHERE agent = ?").run(agent).changes) > 0;
  }
  sessions(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY agent").all() as unknown as SessionRow[];
    return rows.map((r) => this.toSession(r));
  }
  private toSession(r: SessionRow): Session {
    return {
      address: `${this.user}/${r.agent}`,
      user: this.user,
      agent: r.agent,
      kind: r.kind as SessionKind,
      status: r.status as SessionStatus,
      task: r.task,
      last_activity: r.last_activity,
    };
  }
}

interface OutboxRow {
  id: string;
  envelope: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}
interface InboxRow {
  envelope: string;
  received_at: string;
  handled: number;
  remote: number;
}
interface UploadRow {
  id: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
  mime: string | null;
  created_at: string;
}
interface SessionRow {
  agent: string;
  kind: string;
  status: string;
  task: string;
  last_activity: string;
}

function rowToOutbox(r: OutboxRow): OutboxItem {
  return {
    envelope: JSON.parse(r.envelope),
    attempts: r.attempts,
    next_attempt_at: r.next_attempt_at,
    last_error: r.last_error,
  };
}
function rowToInbox(r: InboxRow): InboxItem {
  return { envelope: JSON.parse(r.envelope), received_at: r.received_at, handled: !!r.handled, remote: !!r.remote };
}
