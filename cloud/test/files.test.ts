// Route tests for files through the website (contracts/uploads.md "Website"): limits, who may read, completion
// checks, the message rules, and cleanup. Real route handlers on MemoryStore + MemoryFileStorage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setDeps } from "../lib/server/deps.ts";
import { MemoryFileStorage, MemoryStore, RecordingBroadcaster } from "./memory-store.ts";
import * as login from "../app/api/auth/login/route.ts";
import * as people from "../app/api/admin/people/route.ts";
import * as files from "../app/api/files/route.ts";
import * as fileById from "../app/api/files/[id]/route.ts";
import * as complete from "../app/api/files/[id]/complete/route.ts";
import * as cleanup from "../app/api/files/cleanup/route.ts";
import * as messages from "../app/api/messages/route.ts";

const MASTER = "master-code-for-tests-0123456789";
const CRON = "cron-secret-for-tests-0123";
const env = { owner: "bryant", masterCode: MASTER, sessionSecret: "s".repeat(40), supabaseUrl: "https://sb.test", supabaseAnonKey: "a", supabaseServiceKey: "k", supabaseJwtSecret: "j".repeat(40), hubName: "t", cronSecret: CRON };
const SHA = "a".repeat(64);

function fresh() {
  const store = new MemoryStore();
  const storage = new MemoryFileStorage();
  const clock = { t: Date.now() };
  setDeps({ env, store, broadcaster: new RecordingBroadcaster(), now: () => clock.t, files: storage });
  return { store, storage, clock };
}
type H = (req: Request, ctx: any) => Promise<Response>;
async function call(h: H, method: string, path: string, o: { bearer?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "agentlink.test", "x-forwarded-for": "203.0.113.9" };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await h(new Request(`https://agentlink.test${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
async function people3() {
  const owner = (await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER } })).body.session as string;
  const as = async (user: string) => {
    const code = (await call(people.POST, "POST", "/api/admin/people", { bearer: owner, body: { user } })).body.code;
    return (await call(login.POST, "POST", "/api/auth/login", { body: { code, user } })).body.session as string;
  };
  return { owner, sam: await as("sam"), lee: await as("lee") };
}

test("reserve, upload, complete, send, download: only the recipient and the uploader can read", async () => {
  const { storage, store } = fresh();
  const s = await people3();
  const made = await call(files.POST, "POST", "/api/files", { bearer: s.owner, body: { name: "../deck.pptx", size: 5, sha256: SHA, mime: "application/vnd.ms-powerpoint" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.name, "deck.pptx");
  assert.match(made.body.upload_url, /upload\/sign\/test-bucket\/bryant\//);
  const id = made.body.id as string;
  assert.equal((await call(complete.POST, "POST", "/", { bearer: s.owner, params: { id } })).status, 409); // nothing uploaded yet
  storage.objects.set(`bryant/${id}`, Buffer.from("1234"));
  assert.equal((await call(complete.POST, "POST", "/", { bearer: s.owner, params: { id } })).status, 400); // short: refused, bytes dropped
  storage.objects.set(`bryant/${id}`, Buffer.from("12345"));
  assert.equal((await call(complete.POST, "POST", "/", { bearer: s.owner, params: { id } })).status, 200);

  const att = { id, name: "evil.png", size: 999, sha256: "b".repeat(64), path: "/etc/passwd" };
  const sent = await call(messages.POST, "POST", "/api/messages", { bearer: s.owner, body: { to: "sam/orchestrator", type: "chat", body: { text: "hi", attachments: [att] } } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const stored = await store.getMessage(sent.body.id);
  // the server's facts, not the client's, and never a path
  assert.deepEqual((stored!.body as any).attachments, [{ id, name: "deck.pptx", size: 5, sha256: SHA, mime: "application/vnd.ms-powerpoint" }]);
  assert.deepEqual((await store.getFile(id))!.recipients, ["sam"]);

  const dl = await call(fileById.GET, "GET", "/", { bearer: s.sam, params: { id } });
  assert.equal(dl.status, 200);
  assert.match(dl.body.url, /object\/sign\/test-bucket\/bryant\//);
  assert.equal((await call(fileById.GET, "GET", "/", { bearer: s.owner, params: { id } })).status, 200);
  assert.equal((await call(fileById.GET, "GET", "/", { bearer: s.lee, params: { id } })).status, 404);
});

test("limits and checks", async () => {
  fresh();
  const s = await people3();
  const post = (body: unknown) => call(files.POST, "POST", "/api/files", { bearer: s.sam, body });
  assert.equal((await post({ name: "big.mp4", size: 200 * 1024 ** 2 + 1, sha256: SHA })).status, 413);
  assert.equal((await post({ name: "x", size: 1, sha256: "nothex" })).status, 400);
  assert.equal((await post({ name: "", size: 1, sha256: SHA })).status, 400);
  assert.equal((await post({ id: "NOT-A-UUID", name: "x", size: 1, sha256: SHA })).status, 400);
  assert.equal((await call(files.POST, "POST", "/api/files", { body: { name: "x", size: 1, sha256: SHA } })).status, 401);
  const id = crypto.randomUUID();
  assert.equal((await post({ id, name: "a.txt", size: 1, sha256: SHA })).status, 201);
  assert.equal((await post({ id, name: "a.txt", size: 1, sha256: SHA })).status, 201); // same sender, same bytes: a retry
  assert.equal((await call(files.POST, "POST", "/api/files", { bearer: s.lee, body: { id, name: "a.txt", size: 1, sha256: SHA } })).status, 409);
});

test("a message may only name the sender's own finished files", async () => {
  const { storage } = fresh();
  const s = await people3();
  const id = (await call(files.POST, "POST", "/api/files", { bearer: s.sam, body: { name: "a.txt", size: 2, sha256: SHA } })).body.id;
  const send = (bearer: string) => call(messages.POST, "POST", "/api/messages", { bearer, body: { to: "bryant/orchestrator", type: "chat", body: { text: "x", attachments: [{ id, name: "a.txt", size: 2, sha256: SHA }] } } });
  assert.equal((await send(s.sam)).body.reason, "bad_attachment"); // not uploaded yet
  storage.objects.set(`sam/${id}`, Buffer.from("ab"));
  await call(complete.POST, "POST", "/", { bearer: s.sam, params: { id } });
  assert.equal((await send(s.lee)).body.reason, "bad_attachment"); // not lee's file
  assert.equal((await send(s.sam)).status, 200);
});

test("cleanup: expired files go, bytes and rows; cron secret or the owner only", async () => {
  const { store, storage, clock } = fresh();
  const s = await people3();
  const id = (await call(files.POST, "POST", "/api/files", { bearer: s.sam, body: { name: "a.txt", size: 1, sha256: SHA } })).body.id;
  storage.objects.set(`sam/${id}`, Buffer.from("a"));
  assert.equal((await call(cleanup.POST, "POST", "/", { bearer: s.sam })).status, 403);
  clock.t += 8 * 24 * 60 * 60_000;
  const r = await call(cleanup.GET, "GET", "/", { bearer: CRON });
  assert.deepEqual(r.body, { deleted: 1 });
  assert.equal(await store.getFile(id), null);
  assert.equal(storage.objects.size, 0);
  assert.equal((await call(cleanup.POST, "POST", "/", { bearer: s.owner })).status, 200);
});
