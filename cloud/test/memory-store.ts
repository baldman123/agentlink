// In-memory Store with the same semantics as the SQL functions in supabase/migrations, for route-level tests.
import type { ContextEntry, Envelope, StoredMessage } from "../../contracts/index.ts";
import type { ClaudeUsage, UsageRow } from "../../contracts/usage.ts";
import type { Call, CallAnswer, CallUpload } from "../../contracts/calls.ts";
import type { Broadcaster, DeliveryRow, MessageQuery, PaneInputRow, PersonRow, SessionRow, Store } from "../lib/server/store.ts";

const userOf = (a: string) => a.split("/")[0];
const iso = () => new Date().toISOString();

export class MemoryStore implements Store {
  people = new Map<string, PersonRow>();
  messages = new Map<string, StoredMessage>();
  deliveries: { seq: number; message_id: string; username: string; envelope: Envelope; acked: boolean }[] = [];
  sessions = new Map<string, SessionRow>();
  context = new Map<string, ContextEntry>();
  inputs = new Map<string, PaneInputRow>();
  failures: { ip: string; at: string }[] = [];
  private seq = 0;
  writes = { sessionUpdates: 0 };

  async hubId() {
    return "hub-test-id";
  }

  async getPerson(user: string) {
    return this.people.get(user) ?? null;
  }
  async getPersonByCodeHash(hash: string) {
    return [...this.people.values()].find((p) => p.code_hash === hash) ?? null;
  }
  async ensureOwner(user: string) {
    const cur = this.people.get(user);
    const row: PersonRow = { username: user, code_hash: null, epoch: 0, is_owner: true, created_at: cur?.created_at ?? iso(), invited_at: cur?.invited_at ?? iso(), revoked_at: null, last_seen: cur?.last_seen ?? null };
    this.people.set(user, row);
    return row;
  }
  async invitePerson(user: string, codeHash: string) {
    const cur = this.people.get(user);
    const row: PersonRow = cur
      ? { ...cur, code_hash: codeHash, epoch: cur.epoch + 1, invited_at: iso(), revoked_at: null }
      : { username: user, code_hash: codeHash, epoch: 1, is_owner: false, created_at: iso(), invited_at: iso(), revoked_at: null, last_seen: null };
    this.people.set(user, row);
    return { row, reinvited: !!cur };
  }
  async revokePerson(user: string) {
    const p = this.people.get(user);
    if (!p || p.is_owner || p.revoked_at) return false;
    p.revoked_at = iso();
    return true;
  }
  async listPeople() {
    return [...this.people.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  async countLoginFailures(ip: string | null, sinceIso: string) {
    return this.failures.filter((f) => f.at >= sinceIso && (ip === null || f.ip === ip)).length;
  }
  async recordLoginFailure(ip: string) {
    this.failures.push({ ip, at: iso() });
  }

  async getMessage(id: string) {
    return this.messages.get(id) ?? null;
  }
  async acceptMessage(msg: StoredMessage, recipients: string[], delivered: Envelope) {
    if (this.messages.has(msg.id)) return false;
    this.messages.set(msg.id, msg);
    for (const r of recipients) this.deliveries.push({ seq: ++this.seq, message_id: msg.id, username: r, envelope: delivered, acked: false });
    return true;
  }
  async queryMessages(q: MessageQuery) {
    const reaches = (addr: string, m: StoredMessage) => m.to === addr || m.to === `${userOf(addr)}/*` || m.to === "*";
    return [...this.messages.values()]
      .filter((m) => userOf(m.from) === q.viewer || m.to === "*" || userOf(m.to) === q.viewer)
      .filter((m) => {
        if (q.address && q.with) return (m.from === q.address && reaches(q.with, m)) || (m.from === q.with && reaches(q.address, m));
        if (q.address) return m.from === q.address || reaches(q.address, m);
        return true;
      })
      .filter((m) => !q.before || m.accepted_at < q.before)
      .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))
      .slice(0, q.limit);
  }
  async pendingDeliveries(user: string, sinceSeq: number, limit: number): Promise<DeliveryRow[]> {
    return this.deliveries.filter((d) => d.username === user && !d.acked && d.seq > sinceSeq).slice(0, limit).map((d) => ({ seq: d.seq, envelope: d.envelope }));
  }
  async ack(user: string, ids: string[]) {
    let n = 0;
    for (const d of this.deliveries) if (d.username === user && ids.includes(d.message_id) && !d.acked) (d.acked = true), n++;
    for (const id of ids) {
      const m = this.messages.get(id);
      if (m && m.state === "accepted" && !this.deliveries.some((d) => d.message_id === id && !d.acked)) {
        m.state = "delivered";
        m.delivered_at = iso();
      }
    }
    return n;
  }

  async upsertSession(user: string, agent: string, kind: any, status: any, task: string) {
    const address = `${user}/${agent}`;
    const cur = this.sessions.get(address);
    if (cur && cur.kind === kind && cur.status === status && cur.task === task) return cur;
    this.writes.sessionUpdates++;
    const row: SessionRow = { address, user, agent, kind, status, task, last_activity: iso(), last_heartbeat: iso() };
    this.sessions.set(address, row);
    return row;
  }
  async getSession(address: string) {
    return this.sessions.get(address) ?? null;
  }
  async deleteSession(address: string) {
    return this.sessions.delete(address);
  }
  async heartbeat(user: string, agents: string[]) {
    const p = this.people.get(user);
    if (p) p.last_seen = iso();
    for (const a of agents) {
      const s = this.sessions.get(`${user}/${a}`);
      if (s) s.last_heartbeat = iso();
    }
  }
  async listSessions() {
    return [...this.sessions.values()];
  }

  async listContext(q?: string) {
    const s = q?.toLowerCase();
    return [...this.context.values()]
      .filter((e) => !s || [e.key, e.title, e.body].some((v) => v.toLowerCase().includes(s)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async getContext(key: string) {
    return this.context.get(key) ?? null;
  }
  async putContext(key: string, w: { title: string; kind: any; body: string; author: string; base_version?: number }) {
    const cur = this.context.get(key) ?? null;
    if (w.base_version !== undefined && w.base_version !== (cur?.version ?? 0)) return { status: 409 as const, current: cur };
    const entry: ContextEntry = { key, title: w.title, kind: w.kind, body: w.body, author: w.author, version: (cur?.version ?? 0) + 1, updated_at: iso() };
    this.context.set(key, entry);
    return { status: 200 as const, entry };
  }
  async deleteContext(key: string) {
    return this.context.delete(key);
  }

  async insertPaneInput(row: Omit<PaneInputRow, "created_at" | "state" | "results">) {
    this.inputs.set(row.id, { ...row, state: "pending", results: null, created_at: iso() });
  }
  async getPaneInput(id: string) {
    return this.inputs.get(id) ?? null;
  }
  async setPaneInputResult(id: string, user: string, state: "done" | "failed", results: Record<string, string>) {
    const r = this.inputs.get(id);
    if (!r || r.username !== user || r.state !== "pending") return false;
    r.state = state;
    r.results = results;
    return true;
  }

  usage = new Map<string, UsageRow>();
  async putUsage(user: string, usage: ClaudeUsage) {
    this.usage.set(user, { user, usage, received_at: iso() });
  }
  async listUsage() {
    return [...this.usage.values()].sort((a, b) => a.user.localeCompare(b.user));
  }

  calls = new Map<string, Call & { user: string }>(); // key <user>\n<id>
  async syncCalls(user: string, uploads: CallUpload[]) {
    const keep = new Set(uploads.map((c) => c.id));
    for (const [k, c] of this.calls) if (c.user === user && !keep.has(c.id)) this.calls.delete(k);
    for (const u of uploads) {
      const cur = this.calls.get(`${user}\n${u.id}`);
      this.calls.set(`${user}\n${u.id}`, { ...u, user, state: cur?.state ?? "pending", answer: cur?.answer ?? null, answered_at: cur?.answered_at ?? null });
    }
    return [...this.calls.values()].filter((c) => c.user === user && c.state === "answering" && c.answer).map((c) => ({ id: c.id, ...c.answer! }));
  }
  async listCalls(user: string) {
    return [...this.calls.values()].filter((c) => c.user === user).sort((a, b) => a.asked_at.localeCompare(b.asked_at)).map(({ user: _u, ...c }) => c);
  }
  async answerCall(user: string, id: string, answer: CallAnswer) {
    const c = this.calls.get(`${user}\n${id}`);
    if (!c) return { ok: false as const, reason: "not_found" as const };
    if (c.state !== "pending") return { ok: false as const, reason: "already_answered" as const };
    Object.assign(c, { state: "answering", answer, answered_at: iso() });
    const { user: _u, ...call } = c;
    return { ok: true as const, call };
  }
}

export class RecordingBroadcaster implements Broadcaster {
  sent: { topic: string; event: string; payload: any }[] = [];
  async send(topic: string, event: string, payload: unknown) {
    this.sent.push({ topic, event, payload });
  }
}
