// Store on Supabase with the service role (bypasses RLS; never reaches a client). Multi-row writes go through
// the SQL functions in supabase/migrations so they are atomic.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ContextEntry, Envelope, StoredMessage } from "../../../contracts/index.ts";
import type { ClaudeUsage, UsageRow } from "../../../contracts/usage.ts";
import type { Call, CallAnswer, CallUpload } from "../../../contracts/calls.ts";
import type { Broadcaster, DeliveryRow, MessageQuery, PaneInputRow, PersonRow, SessionRow, Store } from "./store.ts";

type Row = Record<string, any>;

function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

const toMessage = (r: Row): StoredMessage => ({
  id: r.id, from: r.from_addr, to: r.to_addr, reply_to: r.reply_to, hops: r.hops, type: r.type, body: r.body,
  timestamp: r.timestamp, state: r.state, accepted_at: r.accepted_at, delivered_at: r.delivered_at, drop_reason: r.drop_reason,
});

const toSession = (r: Row): SessionRow => ({
  address: r.address, user: r.username, agent: r.agent, kind: r.kind, status: r.status, task: r.task,
  last_activity: r.last_activity, last_heartbeat: r.last_heartbeat,
});

const toCall = (r: Row): Call => ({
  id: r.id, kind: r.kind, summary: r.summary, details: r.details, why: r.why, from: r.from_label, asked_at: r.asked_at,
  state: r.state, answer: r.state === "answering" ? { choice: r.choice ?? null, note: r.note ?? "" } : null, answered_at: r.answered_at,
});

/** PostgREST `or` filters: values with commas or parentheses must be quoted. Addresses are [a-z0-9_-/*] only. */
const q = (v: string) => `"${v.replace(/"/g, "")}"`;

export class SupabaseStore implements Store {
  readonly db: SupabaseClient;
  private cachedHubId: string | null = null;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async hubId(): Promise<string> {
    if (this.cachedHubId) return this.cachedHubId;
    const got = must(await this.db.from("settings").select("v").eq("k", "hub_id").maybeSingle(), "read hub_id");
    if (got) return (this.cachedHubId = got.v as string);
    must(await this.db.from("settings").upsert({ k: "hub_id", v: crypto.randomUUID() }, { onConflict: "k", ignoreDuplicates: true }), "write hub_id");
    const again = must(await this.db.from("settings").select("v").eq("k", "hub_id").single(), "read hub_id") as Row;
    return (this.cachedHubId = again.v as string);
  }

  async getPerson(user: string) {
    return must(await this.db.from("people").select("*").eq("username", user).maybeSingle(), "getPerson") as PersonRow | null;
  }

  async getPersonByCodeHash(hash: string) {
    return must(await this.db.from("people").select("*").eq("code_hash", hash).maybeSingle(), "getPersonByCodeHash") as PersonRow | null;
  }

  async ensureOwner(user: string) {
    const cur = await this.getPerson(user);
    if (cur?.is_owner && cur.epoch === 0 && !cur.revoked_at) return cur;
    return must(
      await this.db.from("people").upsert({ username: user, is_owner: true, epoch: 0, code_hash: null, revoked_at: null }, { onConflict: "username" }).select().single(),
      "ensureOwner",
    ) as PersonRow;
  }

  async invitePerson(user: string, codeHash: string) {
    const cur = await this.getPerson(user);
    const now = new Date().toISOString();
    if (cur) {
      const row = must(
        await this.db.from("people").update({ code_hash: codeHash, epoch: cur.epoch + 1, invited_at: now, revoked_at: null }).eq("username", user).select().single(),
        "reinvite",
      ) as PersonRow;
      return { row, reinvited: true };
    }
    const row = must(await this.db.from("people").insert({ username: user, code_hash: codeHash, epoch: 1 }).select().single(), "invite") as PersonRow;
    return { row, reinvited: false };
  }

  async revokePerson(user: string) {
    const rows = must(
      await this.db.from("people").update({ revoked_at: new Date().toISOString() }).eq("username", user).eq("is_owner", false).is("revoked_at", null).select("username"),
      "revoke",
    ) as Row[];
    return rows.length > 0;
  }

  async listPeople() {
    return must(await this.db.from("people").select("*").order("username"), "listPeople") as PersonRow[];
  }

  async countLoginFailures(ip: string | null, sinceIso: string) {
    let query = this.db.from("login_failures").select("ip", { count: "exact", head: true }).gte("at", sinceIso);
    if (ip !== null) query = query.eq("ip", ip);
    const r = await query;
    if (r.error) throw new Error(`countLoginFailures: ${r.error.message}`);
    return r.count ?? 0;
  }

  async recordLoginFailure(ip: string) {
    must(await this.db.from("login_failures").insert({ ip }), "recordLoginFailure");
    // keep the table small: drop anything older than a day, now and then
    if (Math.random() < 0.05) await this.db.from("login_failures").delete().lt("at", new Date(Date.now() - 86_400_000).toISOString());
  }

  async getMessage(id: string) {
    const r = must(await this.db.from("messages").select("*").eq("id", id).maybeSingle(), "getMessage");
    return r ? toMessage(r) : null;
  }

  async acceptMessage(msg: StoredMessage, recipients: string[], delivered: Envelope) {
    return must(await this.db.rpc("agentlink_accept_message", { m: msg, recipients, delivered }), "acceptMessage") as boolean;
  }

  async queryMessages(mq: MessageQuery) {
    const v = mq.viewer;
    let query = this.db.from("messages").select("*")
      .or(`from_user.eq.${q(v)},to_user.eq.${q(v)},to_addr.eq.${q("*")}`);
    const reaches = (addr: string) => `to_addr.eq.${q(addr)},to_addr.eq.${q(`${addr.split("/")[0]}/*`)},to_addr.eq.${q("*")}`;
    if (mq.address && mq.with) {
      query = query.or(
        `and(from_addr.eq.${q(mq.address)},or(${reaches(mq.with)})),and(from_addr.eq.${q(mq.with)},or(${reaches(mq.address)}))`,
      );
    } else if (mq.address) {
      query = query.or(`from_addr.eq.${q(mq.address)},${reaches(mq.address)}`);
    }
    if (mq.before) query = query.lt("accepted_at", mq.before);
    const rows = must(await query.order("accepted_at", { ascending: false }).limit(mq.limit), "queryMessages") as Row[];
    return rows.map(toMessage);
  }

  async pendingDeliveries(user: string, sinceSeq: number, limit: number): Promise<DeliveryRow[]> {
    const rows = must(
      await this.db.from("deliveries").select("seq, envelope").eq("username", user).eq("acked", false).gt("seq", sinceSeq).order("seq").limit(limit),
      "pendingDeliveries",
    ) as Row[];
    return rows.map((r) => ({ seq: Number(r.seq), envelope: r.envelope }));
  }

  async ack(user: string, ids: string[]) {
    return must(await this.db.rpc("agentlink_ack", { p_user: user, p_ids: ids }), "ack") as number;
  }

  async upsertSession(user: string, agent: string, kind: string, status: string, task: string) {
    const r = must(await this.db.rpc("agentlink_upsert_session", { p_user: user, p_agent: agent, p_kind: kind, p_status: status, p_task: task }), "upsertSession");
    return toSession(r as Row);
  }

  async getSession(address: string) {
    const r = must(await this.db.from("sessions").select("*").eq("address", address).maybeSingle(), "getSession");
    return r ? toSession(r) : null;
  }

  async deleteSession(address: string) {
    const rows = must(await this.db.from("sessions").delete().eq("address", address).select("address"), "deleteSession") as Row[];
    return rows.length > 0;
  }

  async heartbeat(user: string, agents: string[]) {
    must(await this.db.rpc("agentlink_heartbeat", { p_user: user, p_agents: agents }), "heartbeat");
  }

  async listSessions() {
    return (must(await this.db.from("sessions").select("*").order("address"), "listSessions") as Row[]).map(toSession);
  }

  async listContext(search?: string) {
    let query = this.db.from("context").select("*");
    if (search) {
      const s = `%${search.replace(/[%_\\,()"]/g, "")}%`;
      query = query.or(`key.ilike.${q(s)},title.ilike.${q(s)},body.ilike.${q(s)}`);
    }
    return must(await query.order("updated_at", { ascending: false }), "listContext") as ContextEntry[];
  }

  async getContext(key: string) {
    return must(await this.db.from("context").select("*").eq("key", key).maybeSingle(), "getContext") as ContextEntry | null;
  }

  async putContext(key: string, w: { title: string; kind: string; body: string; author: string; base_version?: number }) {
    const r = must(
      await this.db.rpc("agentlink_put_context", { p_key: key, p_title: w.title, p_kind: w.kind, p_body: w.body, p_author: w.author, p_base: w.base_version ?? null }),
      "putContext",
    ) as Row;
    return r.status === 409 ? { status: 409 as const, current: (r.current as ContextEntry) ?? null } : { status: 200 as const, entry: r.entry as ContextEntry };
  }

  async deleteContext(key: string) {
    const rows = must(await this.db.from("context").delete().eq("key", key).select("key"), "deleteContext") as Row[];
    return rows.length > 0;
  }

  async insertPaneInput(row: Omit<PaneInputRow, "created_at" | "state" | "results">) {
    must(await this.db.from("pane_inputs").insert(row), "insertPaneInput");
  }

  async getPaneInput(id: string) {
    return must(await this.db.from("pane_inputs").select("*").eq("id", id).maybeSingle(), "getPaneInput") as PaneInputRow | null;
  }

  async setPaneInputResult(id: string, user: string, state: "done" | "failed", results: Record<string, string>) {
    const rows = must(
      await this.db.from("pane_inputs").update({ state, results }).eq("id", id).eq("username", user).eq("state", "pending").select("id"),
      "setPaneInputResult",
    ) as Row[];
    return rows.length > 0;
  }

  async putUsage(user: string, usage: ClaudeUsage) {
    must(await this.db.from("claude_usage").upsert({ username: user, usage, received_at: new Date().toISOString() }, { onConflict: "username" }), "putUsage");
  }

  async listUsage(): Promise<UsageRow[]> {
    const rows = must(await this.db.from("claude_usage").select("*").order("username"), "listUsage") as Row[];
    return rows.map((r) => ({ user: r.username, usage: r.usage, received_at: r.received_at }));
  }

  async syncCalls(user: string, calls: CallUpload[]) {
    const rows = must(await this.db.rpc("agentlink_sync_calls", { p_user: user, p_calls: calls }), "syncCalls") as Row[] | null;
    return (rows ?? []).map((r) => ({ id: String(r.id), choice: r.choice ?? null, note: r.note ?? "" }));
  }

  async listCalls(user: string) {
    const rows = must(await this.db.from("calls").select("*").eq("username", user).order("asked_at"), "listCalls") as Row[];
    return rows.map(toCall);
  }

  async answerCall(user: string, id: string, answer: CallAnswer) {
    const rows = must(
      await this.db.from("calls").update({ state: "answering", choice: answer.choice, note: answer.note, answered_at: new Date().toISOString() })
        .eq("username", user).eq("id", id).eq("state", "pending").select(),
      "answerCall",
    ) as Row[];
    if (rows.length) return { ok: true as const, call: toCall(rows[0]) };
    const exists = must(await this.db.from("calls").select("id").eq("username", user).eq("id", id).maybeSingle(), "answerCall");
    return { ok: false as const, reason: exists ? ("already_answered" as const) : ("not_found" as const) };
  }
}

/** Realtime broadcast over Supabase's REST endpoint, as the service role; private channels. */
export class SupabaseBroadcaster implements Broadcaster {
  constructor(private url: string, private serviceKey: string) {}

  async send(topic: string, event: string, payload: unknown) {
    const res = await fetch(`${this.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: true }] }),
    });
    if (!res.ok) throw new Error(`broadcast ${topic}/${event}: HTTP ${res.status}`);
  }
}
