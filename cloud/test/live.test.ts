// Live test against a local Supabase (`supabase start` in cloud/, values in cloud/.env.local):
//   cd cloud && LIVE=1 node --import tsx --test test/live.test.ts
// Runs the real route handlers on SupabaseStore + SupabaseBroadcaster, then checks RLS and Realtime from the
// client side with the JWTs the API mints. Skipped unless LIVE=1. Wipes the agentlink tables first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { setDeps } from "../lib/server/deps.ts";
import { readEnv } from "../lib/server/env.ts";
import { SupabaseBroadcaster, SupabaseStore } from "../lib/server/supabase-store.ts";

import * as login from "../app/api/auth/login/route.ts";
import * as people from "../app/api/admin/people/route.ts";
import * as revoke from "../app/api/admin/people/[user]/revoke/route.ts";
import * as messages from "../app/api/messages/route.ts";
import * as deliveries from "../app/api/deliveries/route.ts";
import * as ack from "../app/api/deliveries/ack/route.ts";
import * as sessionAgent from "../app/api/sessions/[agent]/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import * as heartbeat from "../app/api/heartbeat/route.ts";
import * as contextKey from "../app/api/context/[key]/route.ts";
import * as input from "../app/api/panes/input/route.ts";
import * as screens from "../app/api/screens/route.ts";
import * as health from "../app/api/health/route.ts";

const LIVE = process.env.LIVE === "1";
const ORIGIN = "http://127.0.0.1:3000";

function loadEnvLocal() {
  const f = path.join(import.meta.dirname, "..", ".env.local");
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

let env: ReturnType<typeof readEnv>;
let store: SupabaseStore;
const clients: SupabaseClient[] = [];

async function call(h: (req: Request, ctx: any) => Promise<Response>, method: string, p: string, o: { body?: unknown; bearer?: string; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": "127.0.0.1" };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await h(new Request(`${ORIGIN}${p}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A browser/daemon-side Supabase client acting as a person, with the API-minted JWT. */
async function asPerson(jwt: string): Promise<SupabaseClient> {
  // Both are needed with supabase-js 2.117.2: `accessToken` (so supabase-js's own auth never resets Realtime back to the
  // anon key) AND `await realtime.setAuth(jwt)` before the first subscribe (the callback alone isn't applied in time).
  // Otherwise a channel joins with the anon key: postgres_changes filters fail and private topics refuse it.
  const c = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    accessToken: async () => jwt,
    realtime: { params: { eventsPerSecond: 50 } },
  });
  await c.realtime.setAuth(jwt);
  clients.push(c);
  return c;
}

const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};

function subscribed(ch: RealtimeChannel): Promise<string> {
  return new Promise((resolve) => ch.subscribe((status) => {
    if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve(status);
  }));
}

const envelope = (from: string, to: string) => ({
  id: crypto.randomUUID(), from, to, reply_to: null, hops: 0, type: "task", body: { text: "live test" }, timestamp: new Date().toISOString(),
});

before(async () => {
  if (!LIVE) return;
  loadEnvLocal();
  env = readEnv();
  store = new SupabaseStore(env.supabaseUrl, env.supabaseServiceKey);
  for (const t of ["deliveries", "messages", "sessions", "context", "pane_inputs", "login_failures", "people"]) {
    const { error } = await store.db.from(t).delete().not(t === "context" ? "key" : t === "sessions" ? "address" : t === "people" ? "username" : t === "login_failures" ? "ip" : "id", "is", null);
    if (error && t !== "deliveries") throw new Error(`wipe ${t}: ${error.message}`);
  }
  await store.db.from("deliveries").delete().gte("seq", 0);
  setDeps({ env, store, broadcaster: new SupabaseBroadcaster(env.supabaseUrl, env.supabaseServiceKey), now: () => Date.now() });
});

after(async () => {
  for (const c of clients) await c.removeAllChannels();
});

test("live: the whole flow against local Supabase", { skip: !LIVE }, async () => {
  assert.equal((await call(health.GET, "GET", "/api/health")).status, 200);

  // owner + two invitees
  const owner = (await call(login.POST, "POST", "/api/auth/login", { body: { code: env.masterCode } })).body;
  assert.equal(owner.user, "bryant");
  const codes: Record<string, string> = {};
  for (const u of ["sam", "carol"]) codes[u] = (await call(people.POST, "POST", "/api/admin/people", { bearer: owner.session, body: { user: u } })).body.code;
  const sam = (await call(login.POST, "POST", "/api/auth/login", { body: { code: codes.sam } })).body;
  const carol = (await call(login.POST, "POST", "/api/auth/login", { body: { code: codes.carol } })).body;
  assert.equal(sam.user, "sam");
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: "alc_wrong_wrong_wrong" } })).status, 401);

  // Realtime: sam listens for his deliveries, carol listens to messages (RLS must hide bryant<->sam from her)
  const samC = await asPerson(sam.realtime.jwt);
  const carolC = await asPerson(carol.realtime.jwt);
  const samGot: any[] = [];
  const carolSaw: any[] = [];
  const samDeliv = samC.channel("deliv-sam").on("postgres_changes", { event: "INSERT", schema: "public", table: "deliveries", filter: "username=eq.sam" }, (p) => samGot.push(p.new));
  const carolMsgs = carolC.channel("msgs-carol").on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => carolSaw.push(p.new));
  assert.equal(await subscribed(samDeliv), "SUBSCRIBED");
  assert.equal(await subscribed(carolMsgs), "SUBSCRIBED");
  await new Promise((r) => setTimeout(r, 1500)); // postgres_changes needs a moment after SUBSCRIBED

  const e = envelope("bryant/orchestrator", "sam/orchestrator");
  assert.deepEqual((await call(messages.POST, "POST", "/api/messages", { bearer: owner.session, body: { envelope: e } })).body, { id: e.id, accepted: true });
  const bc = envelope("bryant/orchestrator", "*");
  await call(messages.POST, "POST", "/api/messages", { bearer: owner.session, body: { envelope: bc } });
  const d = await until("sam's delivery over Realtime", () => samGot.find((r) => r.message_id === e.id));
  assert.equal(d.envelope.hops, 1);
  assert.equal(d.envelope.from, "bryant/orchestrator");
  await until("carol sees the broadcast", () => carolSaw.find((m) => m.id === bc.id));
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!carolSaw.some((m) => m.id === e.id), "RLS: carol's Realtime feed never carries bryant->sam");

  // RLS on plain selects with the minted JWTs
  const carolRows = (await carolC.from("messages").select("id")).data ?? [];
  assert.ok(carolRows.some((r) => r.id === bc.id) && !carolRows.some((r) => r.id === e.id), "carol reads only broadcasts here");
  const samRows = (await samC.from("messages").select("id")).data ?? [];
  assert.ok(samRows.some((r) => r.id === e.id));
  assert.equal(((await carolC.from("deliveries").select("message_id").eq("username", "sam")).data ?? []).length, 0, "carol can't read sam's deliveries");
  assert.equal(((await carolC.from("people").select("*")).data ?? []).length, 0, "people is not readable by clients");
  const write = await samC.from("messages").insert({ id: "x", from_addr: "sam/a", to_addr: "*", from_user: "sam", hops: 0, type: "chat", body: {}, timestamp: "", state: "accepted" });
  assert.ok(write.error, "clients can't write tables");
  const anon = createClient(env.supabaseUrl, env.supabaseAnonKey, { auth: { persistSession: false } });
  assert.equal(((await anon.from("messages").select("id")).data ?? []).length, 0, "anon reads nothing");

  // resume + ack through the API (SQL functions)
  const pending = (await call(deliveries.GET, "GET", "/api/deliveries", { bearer: sam.session })).body.deliveries;
  assert.ok(pending.some((p: any) => p.envelope.id === e.id) && pending.some((p: any) => p.envelope.id === bc.id));
  assert.equal((await call(ack.POST, "POST", "/api/deliveries/ack", { bearer: sam.session, body: { ids: [e.id] } })).body.acked, 1);
  assert.equal((await store.getMessage(e.id))!.state, "delivered");

  // scoped history via the API
  const carolHist = (await call(messages.GET, "GET", "/api/messages?limit=100", { bearer: carol.session })).body.messages;
  assert.ok(!carolHist.some((m: any) => m.id === e.id) && carolHist.some((m: any) => m.id === bc.id));
  const conv = (await call(messages.GET, "GET", "/api/messages?address=bryant/orchestrator&with=sam/orchestrator", { bearer: sam.session })).body.messages;
  // like the LAN hub, a conversation includes either side's broadcasts to "*"
  assert.ok(conv.some((m: any) => m.id === e.id) && conv.every((m: any) => ["bryant/orchestrator", "sam/orchestrator"].includes(m.from)));

  // sessions (the upsert function), heartbeat, presence
  const put = await call(sessionAgent.PUT, "PUT", "/api/sessions/orchestrator", { bearer: sam.session, body: { kind: "orchestrator", status: "idle", task: "" }, params: { agent: "orchestrator" } });
  assert.equal(put.body.address, "sam/orchestrator");
  await call(sessionAgent.PUT, "PUT", "/api/sessions/worker-1", { bearer: sam.session, body: { kind: "worker", status: "working", task: "t1" }, params: { agent: "worker-1" } });
  await call(heartbeat.POST, "POST", "/api/heartbeat", { bearer: sam.session, body: { agents: ["orchestrator", "worker-1"] } });
  const users = (await call(sessions.GET, "GET", "/api/sessions", { bearer: carol.session })).body.users;
  const samP = users.find((u: any) => u.user === "sam");
  assert.equal(samP.connected, true);
  assert.equal(samP.sessions.length, 2);
  assert.equal(((await carolC.from("sessions").select("address")).data ?? []).length, 2, "sessions readable by every active person");

  // context (versioned SQL function)
  const c1 = await call(contextKey.PUT, "PUT", "/api/context/plan", { bearer: sam.session, body: { title: "Plan", kind: "note", body: "v1" }, params: { key: "plan" } });
  assert.equal(c1.body.version, 1);
  assert.equal((await call(contextKey.PUT, "PUT", "/api/context/plan", { bearer: carol.session, body: { title: "Plan", kind: "note", body: "v2", base_version: 0 }, params: { key: "plan" } })).status, 409);

  // private broadcast channels: sam receives input:sam; carol can't join it
  const samInput: any[] = [];
  const samCh = samC.channel("input:sam", { config: { private: true } }).on("broadcast", { event: "input" }, (m) => samInput.push(m.payload));
  assert.equal(await subscribed(samCh), "SUBSCRIBED");
  const carolSpy = carolC.channel("input:sam", { config: { private: true } });
  const spyStatus = await subscribed(carolSpy);
  assert.notEqual(spyStatus, "SUBSCRIBED", "carol must not be able to join input:sam");
  const r = await call(input.POST, "POST", "/api/panes/input", { bearer: sam.session, body: { agents: ["worker-1"], text: "echo hi" } });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const frame = await until("sam's input frame", () => samInput.find((f) => f.id === r.body.id));
  assert.equal(frame.user, "sam");
  assert.match(frame.sig, /^[0-9a-f]{64}$/);
  const { data: stored } = await samC.from("pane_inputs").select("*").eq("id", r.body.id).single();
  assert.equal(stored!.chars, 7);
  assert.ok(!JSON.stringify(stored).includes("echo hi"));

  // screens: carol watches the shared channel and gets sam's pane
  const carolScreens: any[] = [];
  const scrCh = carolC.channel("screens", { config: { private: true } }).on("broadcast", { event: "screen" }, (m) => carolScreens.push(m.payload));
  assert.equal(await subscribed(scrCh), "SUBSCRIBED");
  assert.equal((await call(screens.POST, "POST", "/api/screens", { bearer: sam.session, body: { screen: { agent: "worker-1", text: "$ ls", cols: 80, rows: 24, busy: false } } })).status, 204);
  const shot = await until("carol gets sam's screen", () => carolScreens.find((s) => s.address === "sam/worker-1"));
  assert.equal(shot.screen.text, "$ ls");
  // a client can't broadcast fake screens itself: sam listens, carol sends on her joined channel, nothing arrives
  const samScreens: any[] = [];
  const samScr = samC.channel("screens", { config: { private: true } }).on("broadcast", { event: "screen" }, (m) => samScreens.push(m.payload));
  assert.equal(await subscribed(samScr), "SUBSCRIBED");
  await scrCh.send({ type: "broadcast", event: "screen", payload: { address: "bryant/orchestrator", screen: { text: "FAKE" } } });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!samScreens.some((s) => s.address === "bryant/orchestrator"), "a client's own broadcast on 'screens' is refused");

  // revoke: sam's channel gets 'revoked', and his JWT stops reading at once (epoch/revoked check in RLS)
  const samUserEvents: any[] = [];
  const userCh = samC.channel("user:sam", { config: { private: true } }).on("broadcast", { event: "revoked" }, (m) => samUserEvents.push(m.payload));
  assert.equal(await subscribed(userCh), "SUBSCRIBED");
  assert.equal((await call(revoke.POST, "POST", "/api/admin/people/sam/revoke", { bearer: owner.session, params: { user: "sam" } })).status, 200);
  await until("revoked broadcast", () => samUserEvents.length > 0);
  assert.equal(((await samC.from("messages").select("id")).data ?? []).length, 0, "a revoked person's JWT reads nothing");
  assert.equal((await call(deliveries.GET, "GET", "/api/deliveries", { bearer: sam.session })).body.error, "revoked");
});
