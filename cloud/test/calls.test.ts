// Route-level tests for "Your calls" (contracts/calls.ts): the real handlers on an in-memory store.
//   cd cloud && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { setDeps } from "../lib/server/deps.ts";
import { MemoryStore, RecordingBroadcaster } from "./memory-store.ts";

import * as login from "../app/api/auth/login/route.ts";
import * as people from "../app/api/admin/people/route.ts";
import * as calls from "../app/api/calls/route.ts";
import * as sync from "../app/api/calls/sync/route.ts";
import * as answer from "../app/api/calls/[id]/answer/route.ts";

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
  setDeps({ env, store, broadcaster: new RecordingBroadcaster(), now: () => Date.now() });
  return store;
}

type Handler = (req: Request, ctx: any) => Promise<Response>;
async function call(h: Handler, method: string, path: string, o: { body?: unknown; bearer?: string; cookie?: string; origin?: string; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "agentlink.test", "x-forwarded-for": "203.0.113.7" };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.cookie) headers.cookie = `al_session=${o.cookie}`;
  if (o.origin) headers.origin = o.origin;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const res = await h(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signIn(code: string): Promise<string> {
  const r = await call(login.POST, "POST", "/api/auth/login", { body: { code } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.session;
}

/** bryant (owner) and sam, both signed in. */
async function team() {
  const bryant = await signIn(MASTER);
  const inv = await call(people.POST, "POST", "/api/admin/people", { bearer: bryant, body: { user: "sam" } });
  return { bryant, sam: await signIn(inv.body.code) };
}

const perm = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "permission", summary: "Quarter 2 wants to push the branch to GitHub, which others can see; Yes lets it push.",
  details: "Bash: git push origin feature", why: "sends data to a server", from: "quarter 2", asked_at: "2026-10-17T04:00:00.000Z", ...extra,
});
const question = (id: string) => ({
  id, kind: "question", summary: "The boss asks whether to spend money on a domain; Yes buys it.", details: "Buy agentlink.dev for $12?", why: null,
  from: "the boss", asked_at: "2026-10-17T04:01:00.000Z",
});

const list = (s: string) => call(calls.GET, "GET", "/api/calls", { cookie: s });
const put = (s: string, c: unknown[]) => call(sync.PUT, "PUT", "/api/calls/sync", { bearer: s, body: { calls: c } });
const ans = (s: string, id: string, body: unknown) => call(answer.POST, "POST", `/api/calls/${id}/answer`, { cookie: s, origin: ORIGIN, body, params: { id } });

test("calls need a session", async () => {
  fresh();
  assert.equal((await call(calls.GET, "GET", "/api/calls")).status, 401);
  assert.equal((await call(sync.PUT, "PUT", "/api/calls/sync", { body: { calls: [] } })).status, 401);
  assert.equal((await call(answer.POST, "POST", "/api/calls/0abcd/answer", { body: { choice: "yes" }, params: { id: "0abcd" } })).status, 401);
});

test("a synced call shows up for its owner only, plain-English summary first, oldest first", async () => {
  fresh();
  const t = await team();
  assert.deepEqual((await put(t.bryant, [question("q01234"), perm("2abcd")])).body, { answers: [] });
  const mine = await list(t.bryant);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.calls.map((c: any) => c.id), ["2abcd", "q01234"]);
  const c = mine.body.calls[0];
  assert.equal(c.summary, perm("x").summary);
  assert.equal(c.details, "Bash: git push origin feature");
  assert.equal(c.state, "pending");
  assert.equal(c.answer, null);
  // sam sees none of bryant's, and can't answer them
  assert.deepEqual((await list(t.sam)).body.calls, []);
  assert.equal((await ans(t.sam, "2abcd", { choice: "yes" })).status, 404);
  // and sam's own sync doesn't touch bryant's rows
  await put(t.sam, [perm("1zzzz")]);
  assert.equal((await list(t.bryant)).body.calls.length, 2);
  assert.deepEqual((await list(t.sam)).body.calls.map((c: any) => c.id), ["1zzzz"]);
});

test("sync refuses a call without a plain-English summary or with a bad id", async () => {
  fresh();
  const t = await team();
  assert.equal((await put(t.bryant, [perm("2abcd", { summary: "   " })])).status, 400);
  assert.equal((await put(t.bryant, [perm("../x")])).status, 400);
  assert.equal((await put(t.bryant, [perm("2abcd", { kind: "other" })])).status, 400);
  assert.equal((await call(sync.PUT, "PUT", "/api/calls/sync", { bearer: t.bryant, body: { calls: "nope" } })).status, 400);
  assert.equal((await put(t.bryant, Array.from({ length: 51 }, (_, i) => perm(`x${i}`)))).status, 400);
  assert.deepEqual((await list(t.bryant)).body.calls, []);
});

test("answer on the site: answering until the daemon delivers it, then gone", async () => {
  fresh();
  const t = await team();
  await put(t.bryant, [perm("2abcd"), question("q01234")]);
  const a = await ans(t.bryant, "2abcd", { choice: "yes", note: "  fine, push it  " });
  assert.equal(a.status, 200);
  assert.equal(a.body.call.state, "answering");
  assert.deepEqual(a.body.call.answer, { choice: "yes", note: "fine, push it" });
  // a second answer (another tab) is refused
  assert.equal((await ans(t.bryant, "2abcd", { choice: "no" })).status, 409);
  // the daemon's next sync still lists it (not delivered yet): it gets the answer, and the row keeps it
  const s1 = await put(t.bryant, [perm("2abcd"), question("q01234")]);
  assert.deepEqual(s1.body.answers, [{ id: "2abcd", choice: "yes", note: "fine, push it" }]);
  assert.equal((await list(t.bryant)).body.calls.find((c: any) => c.id === "2abcd").state, "answering");
  // delivered: the daemon stops listing it and the row goes
  const s2 = await put(t.bryant, [question("q01234")]);
  assert.deepEqual(s2.body.answers, []);
  assert.deepEqual((await list(t.bryant)).body.calls.map((c: any) => c.id), ["q01234"]);
});

test("answered on the boss circle: the next sync drops it from the site", async () => {
  fresh();
  const t = await team();
  await put(t.bryant, [perm("2abcd"), question("q01234")]);
  await put(t.bryant, [question("q01234")]);
  assert.deepEqual((await list(t.bryant)).body.calls.map((c: any) => c.id), ["q01234"]);
  assert.equal((await ans(t.bryant, "2abcd", { choice: "yes" })).status, 404);
  await put(t.bryant, []);
  assert.deepEqual((await list(t.bryant)).body.calls, []);
});

test("a question takes a free-text answer without Yes or No", async () => {
  fresh();
  const t = await team();
  await put(t.bryant, [question("q01234")]);
  assert.equal((await ans(t.bryant, "q01234", {})).status, 400);
  assert.equal((await ans(t.bryant, "q01234", { note: "   " })).status, 400);
  const a = await ans(t.bryant, "q01234", { note: "the second option" });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.call.answer, { choice: null, note: "the second option" });
  assert.deepEqual((await put(t.bryant, [question("q01234")])).body.answers, [{ id: "q01234", choice: null, note: "the second option" }]);
});

test("answer validation and the same-origin rule", async () => {
  fresh();
  const t = await team();
  await put(t.bryant, [perm("2abcd")]);
  assert.equal((await ans(t.bryant, "2abcd", { choice: "maybe" })).status, 400);
  assert.equal((await ans(t.bryant, "2abcd", { choice: "no", note: "x".repeat(501) })).status, 400);
  assert.equal((await ans(t.bryant, "2abcd", { choice: "no", note: 5 })).status, 400);
  assert.equal((await ans(t.bryant, "zz", { choice: "no" })).status, 404);
  const cross = await call(answer.POST, "POST", "/api/calls/2abcd/answer", { cookie: t.bryant, origin: "https://evil.test", body: { choice: "yes" }, params: { id: "2abcd" } });
  assert.equal(cross.status, 403);
  assert.equal((await list(t.bryant)).body.calls[0].state, "pending");
  // free text is for questions only
  assert.equal((await ans(t.bryant, "2abcd", { note: "push it" })).status, 400);
  const no = await ans(t.bryant, "2abcd", { choice: "no" });
  assert.deepEqual(no.body.call.answer, { choice: "no", note: "" });
});
