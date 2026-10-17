// Data access for the API routes. SupabaseStore (supabase-store.ts) is the real one; tests use MemoryStore
// (test/memory-store.ts). Keeping the routes on this interface is what makes route-level tests possible without Postgres.
import type { ContextEntry, ContextKind, Envelope, Session, SessionKind, SessionStatus, StoredMessage } from "../../../contracts/index.ts";
import type { ClaudeUsage, UsageRow } from "../../../contracts/usage.ts";
import type { Call, CallAnswer, CallUpload } from "../../../contracts/calls.ts";

export interface PersonRow {
  username: string;
  code_hash: string | null;
  epoch: number;
  is_owner: boolean;
  created_at: string;
  invited_at: string;
  revoked_at: string | null;
  last_seen: string | null;
}

export interface SessionRow extends Session {
  last_heartbeat: string;
}

export interface DeliveryRow {
  seq: number;
  envelope: Envelope;
}

export interface PaneInputRow {
  id: string;
  username: string;
  agents: string[];
  chars: number;
  state: "pending" | "done" | "failed";
  results: Record<string, string> | null;
  created_at: string;
}

export interface MessageQuery {
  viewer: string;
  address?: string;
  with?: string;
  limit: number;
  before?: string;
}

export interface Store {
  hubId(): Promise<string>;

  // people
  getPerson(user: string): Promise<PersonRow | null>;
  getPersonByCodeHash(hash: string): Promise<PersonRow | null>;
  ensureOwner(user: string): Promise<PersonRow>;
  /** New person (epoch 1) or re-invite (epoch + 1, revoked_at cleared) with this code hash. */
  invitePerson(user: string, codeHash: string): Promise<{ row: PersonRow; reinvited: boolean }>;
  /** False if not an active, non-owner person. */
  revokePerson(user: string): Promise<boolean>;
  listPeople(): Promise<PersonRow[]>;

  // login rate limit
  countLoginFailures(ip: string | null, sinceIso: string): Promise<number>;
  recordLoginFailure(ip: string): Promise<void>;

  // messages
  getMessage(id: string): Promise<StoredMessage | null>;
  /** Stores the message (state accepted or dropped) and one delivery per recipient, atomically. False if the id existed. */
  acceptMessage(msg: StoredMessage, recipients: string[], delivered: Envelope): Promise<boolean>;
  queryMessages(q: MessageQuery): Promise<StoredMessage[]>;
  pendingDeliveries(user: string, sinceSeq: number, limit: number): Promise<DeliveryRow[]>;
  ack(user: string, ids: string[]): Promise<number>;

  // sessions
  upsertSession(user: string, agent: string, kind: SessionKind, status: SessionStatus, task: string): Promise<SessionRow>;
  getSession(address: string): Promise<SessionRow | null>;
  deleteSession(address: string): Promise<boolean>;
  heartbeat(user: string, agents: string[]): Promise<void>;
  listSessions(): Promise<SessionRow[]>;

  // context
  listContext(q?: string): Promise<ContextEntry[]>;
  getContext(key: string): Promise<ContextEntry | null>;
  putContext(key: string, w: { title: string; kind: ContextKind; body: string; author: string; base_version?: number }):
    Promise<{ status: 200; entry: ContextEntry } | { status: 409; current: ContextEntry | null }>;
  deleteContext(key: string): Promise<boolean>;

  // pane input
  insertPaneInput(row: Omit<PaneInputRow, "created_at" | "state" | "results">): Promise<void>;
  getPaneInput(id: string): Promise<PaneInputRow | null>;
  setPaneInputResult(id: string, user: string, state: "done" | "failed", results: Record<string, string>): Promise<boolean>;

  // Claude plan usage (contracts/usage.ts): the latest sample per person
  putUsage(user: string, usage: ClaudeUsage): Promise<void>;
  listUsage(): Promise<UsageRow[]>;

  // "Your calls" (contracts/calls.ts), always scoped to the owning person
  /**
   * Full-state sync from the person's daemon, atomically: upsert every listed call (an answered row keeps its answer),
   * delete the person's rows not listed, and return the rows answered on the site that are still listed.
   */
  syncCalls(user: string, calls: CallUpload[]): Promise<(CallAnswer & { id: string })[]>;
  listCalls(user: string): Promise<Call[]>;
  /** Records a site answer on a pending call. */
  answerCall(user: string, id: string, answer: CallAnswer): Promise<{ ok: true; call: Call } | { ok: false; reason: "not_found" | "already_answered" }>;

  // files (uploads.md "Website")
  /** False when the id is taken. */
  createFile(row: FileRow): Promise<boolean>;
  getFile(id: string): Promise<FileRow | null>;
  markFileUploaded(id: string, at: string): Promise<void>;
  /** Adds users (or "*") to each file's recipients, without duplicates. */
  addFileRecipients(ids: string[], recipients: string[]): Promise<void>;
  /** Files whose expires_at is before `nowIso`, oldest first. */
  expiredFiles(nowIso: string, limit: number): Promise<FileRow[]>;
  deleteFiles(ids: string[]): Promise<void>;
}

/** One file relayed through the website (table files, uploads.md "Website"). */
export interface FileRow {
  id: string;
  uploader: string;
  recipients: string[]; // users who may download it ("*" = everyone), added as messages naming it are accepted
  name: string;
  size: number;
  sha256: string;
  mime: string | null;
  storage_path: string;
  created_at: string;
  uploaded_at: string | null; // set by POST /api/files/:id/complete once Storage has every byte
  expires_at: string;
}

/** The bytes, in a private Storage bucket. Only the API talks to it; clients get short-lived signed URLs. */
export interface FileStorage {
  /** A URL the client PUTs the bytes to (valid about 2 hours). */
  signedUploadUrl(path: string): Promise<string>;
  /** A URL the client GETs the bytes from, valid for `seconds`. */
  signedDownloadUrl(path: string, seconds: number): Promise<string>;
  /** The stored object's size in bytes, or null when nothing is there. */
  size(path: string): Promise<number | null>;
  remove(paths: string[]): Promise<void>;
}

/** Sends a server-originated Realtime broadcast (service role). */
export interface Broadcaster {
  send(topic: string, event: string, payload: unknown): Promise<void>;
}
