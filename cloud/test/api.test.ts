// Route-level tests: the real route handlers, with an in-memory store and a recording broadcaster in place of Supabase.
//   cd cloud && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { jwtVerify } from "jose";
import { setDeps } from "../lib/server/deps.ts";
import { inputSig, sha256hex } from "../lib/server/crypto.ts";
import { MemoryStore, RecordingBroadcaster } from "./memory-store.ts";

import * as health from "../app/api/health/route.ts";
import * as config from "../app/api/config/route.ts";
import * as login from "../app/api/auth/login/route.ts";
import * as refresh from "../app/api/auth/refresh/route.ts";
import * as logout from "../app/api/auth/logout/route.ts";
import * as me from "../app/api/me/route.ts";
import * as snapshot from "../app/api/snapshot/route.ts";
import * as messages from "../app/api/messages/route.ts";
import * as messageById from "../app/api/messages/[id]/route.ts";
import * as deliveries from "../app/api/deliveries/route.ts";
import * as ack from "../app/api/deliveries/ack/route.ts";
import * as sessions from "../app/api/sessions/route.ts";
import * as sessionAgent from "../app/api/sessions/[agent]/route.ts";
import * as heartbeat from "../app/api/heartbeat/route.ts";
import * as context from "../app/api/context/route.ts";
import * as contextKey from "../app/api/context/[key]/route.ts";
import * as screens from "../app/api/screens/route.ts";
import * as screensGone from "../app/api/screens/gone/route.ts";
import * as input from "../app/api/panes/input/route.ts";
import * as inputId from "../app/api/panes/input/[id]/route.ts";
import * as inputResult from "../app/api/panes/input/[id]/result/route.ts";
import * as people from "../app/api/admin/people/route.ts";
import * as revoke from "../app/api/admin/people/[user]/revoke/route.ts";

const ORIGIN = "https://agentlink.test";
const MASTER = "master-code-for-tests-0123456789";
const env = {
  owner: "bryant",
  masterCode: MASTER,
  sessionSecret: "s".repeat(40),
  supabaseUrl: "https://sb.test",
  supabaseAnonKey: "anon-key",
  supabaseServiceKey: "service-key",
  supabaseJwtSecret: "j".repeat(40),
  hubName: "agentlink-test",
};

function fresh() {
  const store = new MemoryStore();
  const broadcaster = new RecordingBroadcaster();
  const clock = { t: Date.now() };
  setDeps({ env, store, broadcaster, now: () => clock.t });
  return { store, broadcaster, clock };
}

type Handler = (req: Request, ctx: any) => Promise<Response>;
interface CallOpts {
  body?: unknown;
  bearer?: string;
  cookie?: string;
  origin?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  ip?: string;
}

async function call(h: Handler, method: string, path: string, o: CallOpts = {}) {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "agentlink.test", "x-forwarded-for": o.ip ?? "203.0.113.7", ...o.headers };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.cookie) headers.cookie = `al_session=${o.cookie}`;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const res = await h(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function signIn(code: string, user?: string) {
  const r = await call(login.POST, "POST", "/api/auth/login", { body: user ? { code, user } : { code } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { user: string; session: string; owner: boolean; realtime: { jwt: string; url: string; anon_key: string } };
}

/** Owner signs in, invites the given people, and they sign in. */
async function team(...names: string[]) {
  const owner = await signIn(MASTER);
  const out: Record<string, { session: string; code: string }> = { bryant: { session: owner.session, code: MASTER } };
  for (const n of names) {
    const inv = await call(people.POST, "POST", "/api/admin/people", { bearer: owner.session, body: { user: n } });
    assert.equal(inv.status, 200);
    out[n] = { session: (await signIn(inv.body.code)).session, code: inv.body.code };
  }
  return out;
}

const envelope = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), from, to, reply_to: null, hops: 0, type: "task", body: "do the thing", timestamp: new Date().toISOString(), ...extra,
});

// ---------------------------------------------------------------- public + login

test("health and config are public", async () => {
  fresh();
  const h = await call(health.GET, "GET", "/api/health");
  assert.deepEqual(h.body, { ok: true, hub_id: "hub-test-id", hub_name: "agentlink-test", protocol: "cloud-1" });
  const c = await call(config.GET, "GET", "/api/config");
  assert.equal(c.body.supabase_url, "https://sb.test");
  assert.equal(c.body.supabase_anon_key, "anon-key");
  assert.ok(!JSON.stringify(c.body).includes("service-key"));
});

test("master code logs in as the owner: cookie, session, 15-minute Realtime JWT", async () => {
  fresh();
  const r = await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user, "bryant");
  assert.equal(r.body.owner, true);
  assert.equal(r.body.hub_id, "hub-test-id");
  const cookie = r.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^al_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure$/);
  assert.equal(r.body.realtime.url, "https://sb.test");
  assert.equal(r.body.realtime.anon_key, "anon-key");
  const { payload } = await jwtVerify(r.body.realtime.jwt, new TextEncoder().encode(env.supabaseJwtSecret), { audience: "authenticated" });
  assert.equal(payload.role, "authenticated");
  assert.equal(payload.app_user, "bryant");
  assert.equal(payload.sub, "bryant");
  assert.equal(payload.epoch, 0);
  assert.ok((payload.exp as number) - (payload.iat as number) === 900);
  // the session token is not a valid Supabase JWT (different key)
  await assert.rejects(jwtVerify(r.body.session, new TextEncoder().encode(env.supabaseJwtSecret)));
});

test("bad codes: 401, recorded; a code with someone else's name is refused", async () => {
  const { store } = fresh();
  const t = await team("sam");
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: "alc_nope_nope_nope" } })).status, 401);
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: t.sam.code, user: "bryant" } })).body.error, "bad_code");
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER, user: "sam" } })).status, 401, "master code works only as the owner");
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: {} })).status, 401);
  assert.equal(store.failures.length, 4);
  const ok = await signIn(t.sam.code, "sam");
  assert.equal(ok.user, "sam");
  assert.equal(ok.owner, false);
});

test("login rate limit: 10 failures per IP in 15 min, then 429 even for a good code; other IPs unaffected", async () => {
  const { store, clock } = fresh();
  for (let i = 0; i < 10; i++) await call(login.POST, "POST", "/api/auth/login", { body: { code: `wrong-code-${i}-xxxx` }, ip: "198.51.100.9" });
  const blocked = await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER }, ip: "198.51.100.9" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.retry_after_s, 900);
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER }, ip: "198.51.100.10" })).status, 200);
  // a global flood blocks everyone
  for (let i = 0; i < 200; i++) store.failures.push({ ip: `10.0.${i >> 8}.${i & 255}`, at: new Date(clock.t).toISOString() });
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER }, ip: "192.0.2.1" })).status, 429);
});

// ---------------------------------------------------------------- sessions, cookies, refresh

test("cookie auth: reads work; writes need this site's Origin; bearer needs none", async () => {
  fresh();
  const t = await team("sam");
  const s = t.sam.session;
  assert.equal((await call(me.GET, "GET", "/api/me", { cookie: s })).body.user, "sam");
  const noOrigin = await call(sessionAgent.PUT, "PUT", "/api/sessions/orchestrator", { cookie: s, body: { kind: "orchestrator", status: "idle", task: "" }, params: { agent: "orchestrator" } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error, "bad_origin");
  const evil = await call(sessionAgent.PUT, "PUT", "/api/sessions/orchestrator", { cookie: s, origin: "https://evil.test", body: { kind: "orchestrator", status: "idle", task: "" }, params: { agent: "orchestrator" } });
  assert.equal(evil.status, 403);
  const good = await call(sessionAgent.PUT, "PUT", "/api/sessions/orchestrator", { cookie: s, origin: ORIGIN, body: { kind: "orchestrator", status: "idle", task: "" }, params: { agent: "orchestrator" } });
  assert.equal(good.status, 200);
  const bearer = await call(sessionAgent.PUT, "PUT", "/api/sessions/worker-1", { bearer: s, body: { kind: "worker", status: "idle", task: "" }, params: { agent: "worker-1" } });
  assert.equal(bearer.status, 200);
  assert.equal((await call(me.GET, "GET", "/api/me")).status, 401);
  assert.equal((await call(me.GET, "GET", "/api/me", { bearer: "garbage" })).status, 401);
});

test("refresh re-mints; logout clears the cookie", async () => {
  fresh();
  const t = await team("sam");
  const r = await call(refresh.POST, "POST", "/api/auth/refresh", { bearer: t.sam.session });
  assert.equal(r.status, 200);
  assert.equal(r.body.user, "sam");
  assert.ok(r.body.realtime.jwt && r.body.session);
  assert.equal(r.headers.get("set-cookie"), null, "bearer refresh sets no cookie");
  const out = await call(logout.POST, "POST", "/api/auth/logout");
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie") ?? "", /^al_session=; .*Max-Age=0/);
});

// ---------------------------------------------------------------- admin: invite, re-invite, revoke

test("admin is owner-only; invite returns a code once; list carries no secrets", async () => {
  const { store } = fresh();
  const t = await team("sam");
  assert.equal((await call(people.GET, "GET", "/api/admin/people", { bearer: t.sam.session })).status, 403);
  assert.equal((await call(people.POST, "POST", "/api/admin/people", { bearer: t.sam.session, body: { user: "eve" } })).status, 403);
  const inv = await call(people.POST, "POST", "/api/admin/people", { bearer: t.bryant.session, body: { user: "carol" } });
  assert.match(inv.body.code, /^alc_[A-Za-z0-9_-]{43}$/);
  assert.equal(inv.body.epoch, 1);
  assert.equal(store.people.get("carol")!.code_hash, sha256hex(inv.body.code));
  assert.equal((await call(people.POST, "POST", "/api/admin/people", { bearer: t.bryant.session, body: { user: "bryant" } })).status, 400);
  assert.equal((await call(people.POST, "POST", "/api/admin/people", { bearer: t.bryant.session, body: { user: "Bad Name" } })).status, 400);
  const list = await call(people.GET, "GET", "/api/admin/people", { bearer: t.bryant.session });
  assert.equal(list.body.owner, "bryant");
  assert.deepEqual(list.body.people.map((p: any) => p.user), ["carol", "sam"]);
  assert.ok(!JSON.stringify(list.body).includes(inv.body.code) && !JSON.stringify(list.body).includes("code_hash"));
});

test("revoke: the session dies at once, the code is refused, a 'revoked' broadcast goes to user:<name>", async () => {
  const { broadcaster } = fresh();
  const t = await team("sam");
  const r = await call(revoke.POST, "POST", "/api/admin/people/sam/revoke", { bearer: t.bryant.session, params: { user: "sam" } });
  assert.equal(r.status, 200);
  assert.ok(broadcaster.sent.some((b) => b.topic === "user:sam" && b.event === "revoked" && b.payload.user === "sam"));
  const after = await call(me.GET, "GET", "/api/me", { bearer: t.sam.session });
  assert.equal(after.status, 401);
  assert.equal(after.body.error, "revoked");
  const relog = await call(login.POST, "POST", "/api/auth/login", { body: { code: t.sam.code } });
  assert.equal(relog.status, 403);
  assert.equal((await call(revoke.POST, "POST", "/api/admin/people/sam/revoke", { bearer: t.bryant.session, params: { user: "sam" } })).status, 404);
  assert.equal((await call(revoke.POST, "POST", "/api/admin/people/bryant/revoke", { bearer: t.bryant.session, params: { user: "bryant" } })).status, 404, "the owner can't be revoked");
});

test("re-invite: new code and epoch; the old code and old session stop working", async () => {
  const { broadcaster } = fresh();
  const t = await team("sam");
  const re = await call(people.POST, "POST", "/api/admin/people", { bearer: t.bryant.session, body: { user: "sam" } });
  assert.equal(re.body.reinvited, true);
  assert.equal(re.body.epoch, 2);
  assert.ok(broadcaster.sent.some((b) => b.topic === "user:sam" && b.event === "revoked"));
  assert.equal((await call(me.GET, "GET", "/api/me", { bearer: t.sam.session })).body.error, "revoked");
  assert.equal((await call(login.POST, "POST", "/api/auth/login", { body: { code: t.sam.code } })).status, 401);
  const s2 = await signIn(re.body.code);
  const { payload } = await jwtVerify(s2.realtime.jwt, new TextEncoder().encode(env.supabaseJwtSecret), { audience: "authenticated" });
  assert.equal(payload.epoch, 2);
});

// ---------------------------------------------------------------- messages

test("send: accepted, one delivery with hops+1; validation like the LAN hub", async () => {
  const { store } = fresh();
  const t = await team("sam");
  const e = envelope("bryant/orchestrator", "sam/orchestrator");
  const r = await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: e } });
  assert.deepEqual(r.body, { id: e.id, accepted: true });
  assert.equal(store.deliveries.length, 1);
  assert.equal(store.deliveries[0].username, "sam");
  assert.equal(store.deliveries[0].envelope.hops, 1);
  // duplicate: accepted again, not routed again
  assert.equal((await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: e } })).status, 200);
  assert.equal(store.deliveries.length, 1);

  const rej = async (env: unknown, reason: string) => {
    const x = await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: env } });
    assert.equal(x.status, 422, reason);
    assert.equal(x.body.reason, reason);
  };
  await rej(envelope("sam/orchestrator", "bryant/orchestrator"), "from_mismatch");
  await rej(envelope("bryant/orchestrator", "dave/orchestrator"), "unknown_target");
  await rej(envelope("bryant/orchestrator", "Not An Address"), "bad_address");
  await rej(envelope("bryant/*", "sam/orchestrator"), "bad_address");
  await rej({ ...envelope("bryant/orchestrator", "sam/x"), type: "nope" }, "bad_envelope");
  const hop = envelope("bryant/orchestrator", "sam/orchestrator", { hops: 5 });
  await rej(hop, "hop_limit");
  assert.equal(store.messages.get(hop.id)!.state, "dropped");
  assert.equal(store.deliveries.length, 1, "nothing delivered for rejected or dropped sends");
  // someone else can't replay my id
  const steal = await call(messages.POST, "POST", "/api/messages", { bearer: t.sam.session, body: { envelope: { ...e, from: "sam/orchestrator" } } });
  assert.equal(steal.status, 422);
});

test("browser form: from <me>/human by default; '*' reaches every active person but the sender", async () => {
  const { store } = fresh();
  const t = await team("sam", "carol");
  const r = await call(messages.POST, "POST", "/api/messages", { cookie: t.sam.session, origin: ORIGIN, body: { to: "bryant/orchestrator", type: "chat", body: "hi boss" } });
  assert.equal(r.status, 200);
  assert.equal(store.messages.get(r.body.id)!.from, "sam/human");
  assert.equal((await call(messages.POST, "POST", "/api/messages", { bearer: t.sam.session, body: { to: "bryant/orchestrator", type: "chat", body: "x", from_agent: "../x" } })).status, 422);
  const b = await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: envelope("bryant/orchestrator", "*", { type: "chat" }) } });
  assert.deepEqual(store.deliveries.filter((d) => d.message_id === b.body.id).map((d) => d.username).sort(), ["carol", "sam"]);
});

test("reads are scoped: a third person never sees messages between two others", async () => {
  fresh();
  const t = await team("sam", "carol");
  const e = envelope("bryant/orchestrator", "sam/worker-1");
  await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: e } });
  const bc = envelope("bryant/orchestrator", "*", { type: "chat" });
  await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: bc } });

  const carolAll = (await call(messages.GET, "GET", "/api/messages?limit=500", { bearer: t.carol.session })).body.messages;
  assert.deepEqual(carolAll.map((m: any) => m.id), [bc.id]);
  const carolAddr = (await call(messages.GET, "GET", "/api/messages?address=sam/worker-1", { bearer: t.carol.session })).body.messages;
  assert.ok(!carolAddr.some((m: any) => m.id === e.id));
  assert.equal((await call(messageById.GET, "GET", `/api/messages/${e.id}`, { bearer: t.carol.session, params: { id: e.id } })).status, 404);
  assert.equal((await call(messageById.GET, "GET", `/api/messages/${bc.id}`, { bearer: t.carol.session, params: { id: bc.id } })).status, 200);
  const samConv = (await call(messages.GET, "GET", "/api/messages?address=bryant/orchestrator&with=sam/worker-1", { bearer: t.sam.session })).body.messages;
  assert.ok(samConv.some((m: any) => m.id === e.id));
  assert.equal((await call(messageById.GET, "GET", `/api/messages/${e.id}`, { bearer: t.sam.session, params: { id: e.id } })).status, 200);
  assert.equal((await call(messages.GET, "GET", "/api/messages?address=BAD", { bearer: t.sam.session })).status, 400);
});

test("deliveries: resume returns unacked rows after since_seq; ack marks the message delivered", async () => {
  const { store } = fresh();
  const t = await team("sam");
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const e = envelope("bryant/orchestrator", "sam/orchestrator");
    ids.push(e.id);
    await call(messages.POST, "POST", "/api/messages", { bearer: t.bryant.session, body: { envelope: e } });
  }
  const all = await call(deliveries.GET, "GET", "/api/deliveries", { bearer: t.sam.session });
  assert.deepEqual(all.body.deliveries.map((d: any) => d.envelope.id), ids);
  assert.equal(all.body.last_seq, all.body.deliveries[2].seq);
  const after = await call(deliveries.GET, "GET", `/api/deliveries?since_seq=${all.body.deliveries[0].seq}`, { bearer: t.sam.session });
  assert.equal(after.body.deliveries.length, 2);
  assert.equal((await call(deliveries.GET, "GET", "/api/deliveries", { bearer: t.bryant.session })).body.deliveries.length, 0, "only your own deliveries");
  const a = await call(ack.POST, "POST", "/api/deliveries/ack", { bearer: t.sam.session, body: { ids: [ids[0], ids[1]] } });
  assert.equal(a.body.acked, 2);
  assert.equal(store.messages.get(ids[0])!.state, "delivered");
  assert.equal(store.messages.get(ids[2])!.state, "accepted");
  assert.equal((await call(deliveries.GET, "GET", "/api/deliveries", { bearer: t.sam.session })).body.deliveries.length, 1);
  assert.equal((await call(ack.POST, "POST", "/api/deliveries/ack", { bearer: t.bryant.session, body: { ids: [ids[2]] } })).body.acked, 0, "can't ack someone else's delivery");
  assert.equal((await call(ack.POST, "POST", "/api/deliveries/ack", { bearer: t.sam.session, body: { ids: "x" } })).status, 400);
});

// ---------------------------------------------------------------- sessions, presence, context

test("sessions: upsert only on change; heartbeat drives connected/offline; snapshot shape", async () => {
  const { store, clock } = fresh();
  const t = await team("sam");
  const put = (status: string) => call(sessionAgent.PUT, "PUT", "/api/sessions/orchestrator", { bearer: t.sam.session, body: { kind: "orchestrator", status, task: "t" }, params: { agent: "orchestrator" } });
  const s = await put("idle");
  assert.equal(s.body.address, "sam/orchestrator");
  assert.equal(s.body.user, "sam");
  assert.ok(!("last_heartbeat" in s.body));
  await put("idle");
  assert.equal(store.writes.sessionUpdates, 1, "an unchanged PUT writes nothing");
  await put("working");
  assert.equal(store.writes.sessionUpdates, 2);
  assert.equal((await call(sessionAgent.PUT, "PUT", "/api/sessions/x", { bearer: t.sam.session, body: { kind: "robot", status: "idle" }, params: { agent: "x" } })).status, 400);

  assert.equal((await call(heartbeat.POST, "POST", "/api/heartbeat", { bearer: t.sam.session, body: { agents: ["orchestrator"] } })).status, 204);
  let users = (await call(sessions.GET, "GET", "/api/sessions", { bearer: t.bryant.session })).body.users;
  let sam = users.find((u: any) => u.user === "sam");
  assert.equal(sam.connected, true);
  assert.equal(sam.sessions[0].status, "working");
  clock.t += 31_000;
  users = (await call(sessions.GET, "GET", "/api/sessions", { bearer: t.bryant.session })).body.users;
  sam = users.find((u: any) => u.user === "sam");
  assert.equal(sam.connected, false);
  assert.equal(sam.sessions[0].status, "offline");

  const snap = await call(snapshot.GET, "GET", "/api/snapshot", { bearer: t.sam.session });
  assert.deepEqual(Object.keys(snap.body).sort(), ["context", "last_seq", "users"]);
  assert.equal(snap.body.last_seq, 0);
  assert.equal((await call(sessionAgent.DELETE, "DELETE", "/api/sessions/orchestrator", { bearer: t.sam.session, params: { agent: "orchestrator" } })).status, 204);
  assert.equal(store.sessions.size, 0);
});

test("context: versioned writes, 409 on conflict, a context_update delivery to everyone", async () => {
  const { store } = fresh();
  const t = await team("sam");
  const put = (body: object, bearer = t.sam.session) => call(contextKey.PUT, "PUT", "/api/context/api-spec", { bearer, body, params: { key: "api-spec" } });
  const a = await put({ title: "API spec", kind: "api_spec", body: "# v1" });
  assert.equal(a.status, 200);
  assert.equal(a.body.version, 1);
  assert.equal(a.body.author, "sam/orchestrator");
  const cu = store.deliveries.filter((d) => d.envelope.type === "context_update");
  assert.deepEqual(cu.map((d) => d.username).sort(), ["bryant", "sam"]);
  assert.equal(cu[0].envelope.to, `${cu[0].username}/*`);
  assert.equal((await put({ title: "API spec", kind: "api_spec", body: "# v2", base_version: 1, agent: "worker-2" }, t.bryant.session)).body.author, "bryant/worker-2");
  const conflict = await put({ title: "x", kind: "note", body: "", base_version: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.current.version, 2);
  assert.equal((await put({ title: "x", kind: "weird", body: "" })).status, 400);
  assert.equal((await call(context.GET, "GET", "/api/context?q=V2", { bearer: t.sam.session })).body.entries.length, 1);
  assert.equal((await call(contextKey.GET, "GET", "/api/context/api-spec", { bearer: t.sam.session, params: { key: "api-spec" } })).body.version, 2);
  assert.equal((await call(contextKey.DELETE, "DELETE", "/api/context/api-spec", { bearer: t.sam.session, params: { key: "api-spec" } })).status, 204);
  assert.equal((await call(contextKey.GET, "GET", "/api/context/BAD KEY", { bearer: t.sam.session, params: { key: "BAD KEY" } })).status, 400);
});

// ---------------------------------------------------------------- screens

test("screens: relayed on 'screens' for own sessions only, throttled, never stored", async () => {
  const { broadcaster, clock } = fresh();
  const t = await team("sam");
  const scr = (agent: string, text = "hello") => call(screens.POST, "POST", "/api/screens", { bearer: t.sam.session, body: { screen: { agent, text, cols: 80, rows: 24, busy: false } } });
  assert.equal((await scr("worker-1")).body.error, "no_session");
  await call(sessionAgent.PUT, "PUT", "/api/sessions/worker-1", { bearer: t.sam.session, body: { kind: "worker", status: "idle", task: "" }, params: { agent: "worker-1" } });
  assert.equal((await scr("worker-1")).status, 204);
  const b = broadcaster.sent.find((x) => x.topic === "screens")!;
  assert.equal(b.event, "screen");
  assert.equal(b.payload.address, "sam/worker-1");
  assert.equal(b.payload.screen.text, "hello");
  assert.equal((await scr("worker-1")).status, 204);
  assert.equal((await scr("worker-1")).status, 429, "a third update inside 3s");
  clock.t += 3_100;
  assert.equal((await scr("worker-1")).status, 204);
  assert.equal((await scr("sam/worker-1")).status, 400, "can't name another user's pane");
  assert.equal((await scr("worker-1", "x".repeat(64 * 1024 + 1))).status, 400);
  assert.equal((await call(screensGone.POST, "POST", "/api/screens/gone", { bearer: t.sam.session, body: { agent: "worker-1" } })).status, 204);
  assert.ok(broadcaster.sent.some((x) => x.topic === "screens" && x.event === "screen.gone" && x.payload.address === "sam/worker-1"));
});

// ---------------------------------------------------------------- typing into your own panes

test("pane input: only to input:<caller>, signed with the caller's code hash, text never stored", async () => {
  const { store, broadcaster, clock } = fresh();
  const t = await team("sam");
  const send = (o: CallOpts) => call(input.POST, "POST", "/api/panes/input", o);
  const body = { agents: ["orchestrator", "worker-2"], text: "SECRET-TEXT-123", submit: true };
  assert.equal((await send({ bearer: t.bryant.session, body })).body.error, "no_daemon");

  await call(heartbeat.POST, "POST", "/api/heartbeat", { bearer: t.bryant.session, body: { agents: [] } });
  assert.equal((await send({ cookie: t.bryant.session, origin: ORIGIN, body })).status, 403, "cookie needs X-Agentlink-Input");
  const r = await send({ cookie: t.bryant.session, origin: ORIGIN, headers: { "x-agentlink-input": "1" }, body });
  assert.equal(r.status, 202);
  const b = broadcaster.sent.find((x) => x.event === "input")!;
  assert.equal(b.topic, "input:bryant");
  assert.equal(b.payload.user, "bryant");
  assert.deepEqual(b.payload.agents, ["orchestrator", "worker-2"]);
  assert.equal(b.payload.text, "SECRET-TEXT-123");
  const { sig, ...frame } = b.payload;
  assert.equal(sig, inputSig(sha256hex(MASTER), frame), "the owner's frame is signed with sha256(master)");
  assert.ok(!JSON.stringify([...store.inputs.values()]).includes("SECRET-TEXT-123"), "the text is not stored");
  assert.equal([...store.inputs.values()][0].chars, 15);

  // sam's frames go to sam's channel only, signed with sam's code
  await call(heartbeat.POST, "POST", "/api/heartbeat", { bearer: t.sam.session, body: { agents: [] } });
  await send({ bearer: t.sam.session, body: { agents: ["worker-1"], text: "ls" } });
  const sb = broadcaster.sent.filter((x) => x.event === "input")[1];
  assert.equal(sb.topic, "input:sam");
  const { sig: ssig, ...sframe } = sb.payload;
  assert.equal(ssig, inputSig(sha256hex(t.sam.code), sframe));
  assert.equal(sframe.submit, true);
  assert.ok(broadcaster.sent.filter((x) => x.event === "input").every((x) => x.topic === `input:${x.payload.user}`));

  for (const bad of [{ agents: [], text: "x" }, { agents: ["worker-9"], text: "x" }, { agents: ["sam/worker-1"], text: "x" }, { agents: ["worker-1"], text: "" }, { agents: ["worker-1"], text: "x".repeat(4001) }]) {
    assert.equal((await send({ bearer: t.sam.session, body: bad })).status, 400, JSON.stringify(bad).slice(0, 60));
  }

  // results: only the owner of the input may report; reported once; GET reads it back
  const id = r.body.id;
  const res = { results: { orchestrator: "sent", "worker-2": "skipped: prompt_open" } };
  assert.equal((await call(inputResult.POST, "POST", `/api/panes/input/${id}/result`, { bearer: t.sam.session, body: res, params: { id } })).status, 404);
  assert.equal((await call(inputId.GET, "GET", `/api/panes/input/${id}`, { bearer: t.sam.session, params: { id } })).status, 404);
  assert.equal((await call(inputId.GET, "GET", `/api/panes/input/${id}`, { bearer: t.bryant.session, params: { id } })).body.state, "pending");
  assert.equal((await call(inputResult.POST, "POST", `/api/panes/input/${id}/result`, { bearer: t.bryant.session, body: { results: { orchestrator: "typed rm -rf" } }, params: { id } })).status, 400);
  assert.equal((await call(inputResult.POST, "POST", `/api/panes/input/${id}/result`, { bearer: t.bryant.session, body: res, params: { id } })).status, 204);
  assert.deepEqual((await call(inputId.GET, "GET", `/api/panes/input/${id}`, { bearer: t.bryant.session, params: { id } })).body, { id, state: "done", ...res });
  assert.equal((await call(inputResult.POST, "POST", `/api/panes/input/${id}/result`, { bearer: t.bryant.session, body: res, params: { id } })).status, 409);

  // an input nobody answers reads as failed after 60s
  const late = await send({ bearer: t.sam.session, body: { agents: ["worker-3"], text: "pwd" } });
  clock.t += 61_000;
  const lateGet = await call(inputId.GET, "GET", `/api/panes/input/${late.body.id}`, { bearer: t.sam.session, params: { id: late.body.id } });
  assert.deepEqual(lateGet.body, { id: late.body.id, state: "failed", results: { "worker-3": "failed: no_daemon" } });
});

test("missing server env -> 500 config, not a crash", async () => {
  setDeps(null);
  const saved = { ...process.env };
  for (const k of ["AGENTLINK_OWNER", "AGENTLINK_MASTER_CODE"]) delete process.env[k];
  try {
    const r = await call(health.GET, "GET", "/api/health");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "config");
  } finally {
    process.env = saved;
  }
});
