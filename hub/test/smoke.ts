// Smoke test: runs an in-process hub on a random port with a temp DB and drives it with fake daemon sockets.
// Run: npm test (from hub/), or: npx tsx test/smoke.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import type { ClientRole, Envelope, ServerFrame, StoredMessage } from "../../contracts/index.ts";
import { PROTOCOL_VERSION } from "../../contracts/index.ts";
import { newNonce } from "../src/auth.ts";
import { handshake, helloFor, type HandshakeResult } from "./handshake.ts";

process.env.AGENTLINK_HUB_LOG ??= join(mkdtempSync(join(tmpdir(), "agentlink-hub-log-")), "hub.log");
// Capture everything the hub prints (its stdout log lines) so the test can prove the token never appears there.
const hubStdout: string[] = [];
console.log = (...args: unknown[]) => void hubStdout.push(args.map(String).join(" "));
const { Hub } = await import("../src/hub.ts");
const { Advertiser, installMdnsCrashGuard, isMdnsError } = await import("../src/mdns.ts");

const TOKEN = "smoke-token";
const dir = mkdtempSync(join(tmpdir(), "agentlink-hub-"));
const dbPath = join(dir, "hub.sqlite");
// alex owns this hub (the master token is alex's key); everyone else needs a personal token from an invite.
const hubOpts = { port: 0, host: "127.0.0.1", token: TOKEN, owner: "alex", dbPath, hubName: "smoke", helloTimeoutMs: 300, sweepIntervalMs: 100, sessionTimeoutMs: 400, restSessionGraceMs: 600 };
let hub = new Hub(hubOpts);
let port = await hub.listen();
const personal = new Map<string, string>();
/** The token a user signs with: the master for the owner, else their (cached) personal token. */
const tokenFor = (user: string) => (user === "alex" ? TOKEN : personal.get(user) ?? TOKEN);
for (const u of ["probe", "sam", "bob"]) personal.set(u, hub.invite(u).token);

let failures = 0;
let passes = 0;
function check(cond: unknown, name: string) {
  if (cond) {
    passes++;
    console.error(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

const allClients: Client[] = [];

class Client {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  raw: string[] = []; // every text frame the hub sent, verbatim
  closeCode: number | null = null;
  opened: Promise<void>;
  session = "";
  private cursor = 0;
  constructor() {
    allClients.push(this);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d) => {
      this.raw.push(d.toString());
      this.frames.push(JSON.parse(d.toString()));
    });
    this.ws.on("close", (code) => (this.closeCode = code));
    this.opened = new Promise((r) => this.ws.once("open", () => r()));
  }
  /** The next frame in arrival order (for the handshake), or null if the socket closed first. */
  async nextFrame(ms = 2000): Promise<ServerFrame | null> {
    const end = Date.now() + ms;
    while (this.cursor >= this.frames.length) {
      if (this.closeCode !== null || Date.now() > end) return null;
      await sleep(5);
    }
    return this.frames[this.cursor++];
  }
  /** Protocol v2 handshake (test/handshake.ts). */
  async v2(o: { user: string; role: ClientRole; since_seq?: number; token?: string; pinHubId?: string }): Promise<HandshakeResult> {
    await this.opened;
    const r = await handshake(this.ws, () => this.nextFrame(), { ...o, token: o.token ?? tokenFor(o.user) });
    if (r.ok) this.session = r.session;
    return r;
  }
  async send(f: unknown) {
    await this.opened;
    this.ws.send(JSON.stringify(f));
  }
  async waitFor<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, ms = 1500): Promise<T | null> {
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < ms) {
      for (; i < this.frames.length; i++) if (pred(this.frames[i])) return this.frames[i] as T;
      await sleep(10);
    }
    return null;
  }
  async waitClose(ms = 1500) {
    const start = Date.now();
    while (this.closeCode === null && Date.now() - start < ms) await sleep(10);
    return this.closeCode;
  }
  count(pred: (f: ServerFrame) => boolean) {
    return this.frames.filter(pred).length;
  }
  close() {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isEvent = (type: string, extra: (e: any) => boolean = () => true) => (f: ServerFrame) =>
  f.op === "event" && f.frame.event.type === type && extra(f.frame.event);

async function daemon(user: string, since_seq?: number) {
  const c = new Client();
  const r = await c.v2({ user, role: "daemon", since_seq });
  if (!r.ok) throw new Error(`handshake for ${user} failed: ${r.reason} ${JSON.stringify(r.detail ?? "")}`);
  await c.waitFor((f) => f.op === "snapshot");
  return c;
}

async function ui(user: string, since_seq?: number) {
  const c = new Client();
  const r = await c.v2({ user, role: "ui", since_seq });
  if (!r.ok) throw new Error(`ui handshake for ${user} failed: ${r.reason}`);
  await c.waitFor((f) => f.op === "snapshot");
  return c;
}

/** The REST bearer the api() helper uses: a session from a live socket's welcome (v2). */
let bearer = "";

function env(from: string, to: string, extra: Partial<Envelope> = {}): Envelope {
  return { id: randomUUID(), from, to, reply_to: null, hops: 0, type: "task", body: "do the thing", timestamp: new Date().toISOString(), ...extra };
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

try {
  console.error("auth (protocol v2)");
  {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    check(health.ok && health.hub_name === "smoke" && health.protocol === 2, "GET /api/health open without token, protocol 2");

    const c0 = new Client();
    const challenge = await c0.nextFrame();
    check(
      challenge?.op === "challenge" && /^[0-9a-f]{64}$/.test(challenge.nonce) && challenge.hub_id === health.hub_id && challenge.protocol === 2,
      "first frame is challenge{nonce (32 bytes hex), hub_id, protocol 2}",
    );
    c0.close();
    const c1 = new Client();
    const challenge2 = await c1.nextFrame();
    check(challenge2?.op === "challenge" && challenge?.op === "challenge" && challenge2.nonce !== challenge.nonce, "every socket gets a fresh nonce");
    c1.close();

    const ok = new Client();
    const good = await ok.v2({ user: "probe", role: "daemon" });
    check(good.ok && good.session.length === 64, "a correct proof gets welcome with a verified server_proof and a session");
    const replay = new Client();
    await replay.nextFrame(); // its own, different challenge
    if (good.ok) await replay.send(good.hello); // the earlier socket's valid hello, replayed
    check(await replay.waitFor((f) => f.op === "error" && f.code === "auth_failed"), "a replayed hello (old nonce/proof) on a new socket -> auth_failed");
    check((await replay.waitClose()) === 4001, "replay -> close 4001");
    await ok.send(good.ok ? good.hello : {});
    check(await ok.waitFor((f) => f.op === "error" && f.code === "protocol"), "a second hello on an authed socket is refused");
    ok.close();

    const wrong = new Client();
    const bad = await wrong.v2({ user: "eve", role: "daemon", token: "not-the-token" });
    check(!bad.ok && bad.reason === "auth_failed", "a proof made with the wrong token -> error auth_failed");
    check((await wrong.waitClose()) === 4001, "wrong proof -> close 4001");

    const tampered = new Client();
    const ch = await tampered.nextFrame();
    if (ch?.op === "challenge") await tampered.send({ ...helloFor(ch, { token: TOKEN, user: "alex", role: "daemon" }), user: "mallory" });
    check((await tampered.waitClose()) === 4001, "a proof for a different user (user swapped after signing) -> 4001");

    const v1 = new Client();
    await v1.nextFrame();
    await v1.send({ op: "hello", token: TOKEN, role: "daemon", user: "old", protocol: 1 });
    check((await v1.waitClose()) === 4001, "a v1 hello carrying the token -> 4001");
    const v1b = new Client();
    const chb = await v1b.nextFrame();
    if (chb?.op === "challenge") await v1b.send({ ...helloFor(chb, { token: TOKEN, user: "old", role: "daemon" }), protocol: 1 });
    check((await v1b.waitClose()) === 4001, "protocol 1 without a token field -> 4001");
    const v3 = new Client();
    const chc = await v3.nextFrame();
    if (chc?.op === "challenge") await v3.send({ ...helloFor(chc, { token: TOKEN, user: "future", role: "daemon" }), protocol: 3 });
    check((await v3.waitClose()) === 4002, "protocol 3 -> 4002");
    const junk = new Client();
    const chd = await junk.nextFrame();
    if (chd?.op === "challenge") await junk.send({ ...helloFor(chd, { token: TOKEN, user: "x", role: "daemon" }), cnonce: "short", proof: "zz" });
    check((await junk.waitClose()) === 4001, "a malformed cnonce/proof -> 4001");

    const silent = new Client();
    await silent.opened;
    check((await silent.waitClose(5000)) === 4001, "no hello within timeout -> close 4001");

    const asToken = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    check(asToken.status === 401, "the shared token as a REST bearer -> 401");
    const madeUp = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${newNonce()}` } });
    check(madeUp.status === 401, "a made-up session -> 401");
    const landing = await fetch(`http://127.0.0.1:${port}/`);
    const html = await landing.text();
    check(landing.status === 200 && (landing.headers.get("content-type") ?? "").startsWith("text/html"), "GET / -> 200 text/html without token");
    check(html.includes("agentlink hub · smoke") && html.includes("not the app") && !html.includes(TOKEN), "landing page names the hub, explains itself, never shows the token");
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    check(noAuth.status === 401, "REST without token -> 401");
  }

  console.error("people: personal tokens, owner-only master, admin");
  {
    const admin = (path: string, init: RequestInit = {}, key = TOKEN) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Authorization: `Admin ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const inv = await admin("/api/admin/people", { method: "POST", body: JSON.stringify({ user: "carol" }) });
    const invBody = await inv.json();
    check(inv.status === 200 && /^[0-9a-f]{64}$/.test(invBody.token) && invBody.epoch === 1 && invBody.hub_id === hub.hubId, "admin invite -> personal token (64 hex), epoch 1, hub_id");
    check(!inv.headers.get("access-control-allow-origin"), "admin responses carry no CORS header");
    personal.set("carol", invBody.token);
    check(invBody.token !== TOKEN && !hubStdout.some((l) => l.includes(invBody.token)), "personal token differs from the master and is never logged");
    personal.set("dave", hub.invite("dave").token);

    const carol = new Client();
    const okCarol = await carol.v2({ user: "carol", role: "daemon" });
    check(okCarol.ok, "personal token works for its own user (daemon)");
    const carolUi = new Client();
    check((await carolUi.v2({ user: "carol", role: "ui" })).ok, "personal token works for its own user (ui)");
    const carolRest = () => fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${carol.session}` } });
    check((await carolRest()).status === 200, "a personal-token socket's session works for REST");

    const asDave = new Client();
    check(!(await asDave.v2({ user: "dave", role: "daemon", token: personal.get("carol") })).ok && (await asDave.waitClose()) === 4001, "carol's token used as user dave (also invited) -> 4001");
    const asStranger = new Client();
    check(!(await asStranger.v2({ user: "mallory", role: "daemon", token: personal.get("carol") })).ok && (await asStranger.waitClose()) === 4001, "carol's token used as an uninvited user -> 4001");
    const masterCarol = new Client();
    check(!(await masterCarol.v2({ user: "carol", role: "daemon", token: TOKEN })).ok && (await masterCarol.waitClose()) === 4001, "the master token as an invited non-owner -> 4001");
    const masterZed = new Client();
    check(!(await masterZed.v2({ user: "zed", role: "ui", token: TOKEN })).ok && (await masterZed.waitClose()) === 4001, "the master token as an uninvited user -> 4001");
    const owner = new Client();
    check((await owner.v2({ user: "alex", role: "ui", token: TOKEN })).ok, "the master token works for the owner");
    owner.close();
    check(hubStdout.some((l) => l.includes('"why":"user not invited or revoked"') && l.includes('"user":"zed"')), "a hello from an uninvited user is logged by name");

    check((await admin("/api/admin/people", { method: "POST", body: JSON.stringify({ user: "alex" }) })).status === 400, "inviting the owner -> 400");
    check((await admin("/api/admin/people", { method: "POST", body: JSON.stringify({ user: "Bad Name" }) })).status === 400, "inviting a bad name -> 400");
    check((await admin("/api/admin/people", {}, "not-the-master")).status === 401, "admin with the wrong master -> 401");
    check((await admin("/api/admin/people", {}, personal.get("carol")!)).status === 401, "admin with a personal token -> 401");
    check((await fetch(`http://127.0.0.1:${port}/api/admin/people`, { headers: { Authorization: `Bearer ${carol.session}` } })).status === 401, "admin with a REST session -> 401");
    const listed = await (await admin("/api/admin/people")).json();
    const lc = listed.people.find((p: any) => p.user === "carol");
    check(listed.owner === "alex" && lc?.connected === true && lc.revoked_at === null && !JSON.stringify(listed).includes(invBody.token), "admin list: owner, carol connected, no tokens in it");

    const rv = await admin("/api/admin/people/carol/revoke", { method: "POST" });
    check(rv.status === 200, "admin revoke -> 200");
    check((await carol.waitClose()) === 4001 && (await carolUi.waitClose()) === 4001, "revoke closes the user's daemon and ui sockets with 4001");
    check(carol.frames.some((f) => f.op === "error" && f.code === "auth_failed" && /revoked/.test(f.message)), "the kicked socket is told its access was revoked");
    check((await carolRest()).status === 401, "revoke drops the user's REST sessions at once (no grace)");
    const again = new Client();
    check(!(await again.v2({ user: "carol", role: "daemon" })).ok && (await again.waitClose()) === 4001, "a revoked token can't reconnect -> 4001");
    check((await admin("/api/admin/people/carol/revoke", { method: "POST" })).status === 404, "revoking twice -> 404");
    const watcher = await ui("dave");
    check(!(await (await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${watcher.session}` } })).json()).users.some((u: any) => u.user === "carol"), "a revoked user drops out of /api/sessions");
    watcher.close();

    const oldCarol = personal.get("carol")!;
    const re = await (await admin("/api/admin/people", { method: "POST", body: JSON.stringify({ user: "carol" }) })).json();
    check(re.reinvited === true && re.epoch === 2 && re.token !== oldCarol, "re-invite -> new token, epoch 2");
    const oldTok = new Client();
    check(!(await oldTok.v2({ user: "carol", role: "daemon", token: oldCarol })).ok, "the token from before the re-invite stays dead");
    personal.set("carol", re.token);
    const carol2 = new Client();
    check((await carol2.v2({ user: "carol", role: "daemon" })).ok, "the re-invited token works");
    const re2 = await (await admin("/api/admin/people", { method: "POST", body: JSON.stringify({ user: "carol" }) })).json();
    check((await carol2.waitClose()) === 4001, "re-inviting someone who is connected kicks their old-token socket");
    personal.set("carol", re2.token);
  }

  // dave watches as a ui from here on: messages between alex and sam must never reach him.
  const daveUi = await ui("dave");

  console.error("handshake + sessions");
  const alex = await daemon("alex");
  check(alex.frames[0]?.op === "challenge" && alex.frames[1]?.op === "welcome" && alex.frames[2]?.op === "snapshot", "challenge, welcome, then snapshot");
  bearer = alex.session;
  const sam = await daemon("sam");
  check(await alex.waitFor(isEvent("user.connected", (e) => e.user === "sam")), "alex sees user.connected sam");
  await sam.send({ op: "session.upsert", session: { agent: "worker", kind: "worker", status: "idle", task: "" } });
  check(await alex.waitFor(isEvent("session.updated", (e) => e.session.address === "sam/worker" && e.session.status === "idle")), "session.upsert -> session.updated");

  console.error("routing + ack");
  const e1 = env("alex/orchestrator", "sam/worker");
  await alex.send({ op: "send", envelope: e1 });
  check(await alex.waitFor((f) => f.op === "accepted" && f.id === e1.id), "send -> accepted");
  const d1 = await sam.waitFor<Extract<ServerFrame, { op: "deliver" }>>((f) => f.op === "deliver" && f.envelope.id === e1.id);
  check(d1 && d1.envelope.hops === 1, "sam receives deliver with hops+1");
  check(alex.count((f) => f.op === "deliver" && f.envelope.id === e1.id) === 0, "sender does not get its own direct message");
  await sam.send({ op: "ack", id: e1.id });
  check(await alex.waitFor(isEvent("message.delivered", (e) => e.id === e1.id && e.to === "sam/worker")), "ack -> message.delivered event");
  const stored = (await api(`/api/messages/${e1.id}`)).body as StoredMessage;
  check(stored.state === "delivered" && stored.delivered_at, "stored state delivered");

  console.error("duplicate id");
  await alex.send({ op: "send", envelope: e1 });
  await alex.waitFor((f) => f.op === "accepted" && f.id === e1.id && alex.count((g) => g.op === "accepted" && g.id === e1.id) >= 2);
  check(alex.count((f) => f.op === "accepted" && f.id === e1.id) === 2, "duplicate -> accepted again");
  await sleep(100);
  check(sam.count((f) => f.op === "deliver" && f.envelope.id === e1.id) === 1, "duplicate not re-routed");

  console.error("hop limit + validation");
  const e2 = env("alex/orchestrator", "sam/worker", { hops: 5 });
  await alex.send({ op: "send", envelope: e2 });
  check(await alex.waitFor((f) => f.op === "rejected" && f.id === e2.id && f.reason === "hop_limit"), "hops 5 (delivery would be 6) -> rejected hop_limit");
  check(await alex.waitFor(isEvent("message.dropped", (e) => e.message.id === e2.id && e.message.drop_reason === "hop_limit")), "message.dropped event");
  check((await api(`/api/messages/${e2.id}`)).body.state === "dropped", "dropped message stored");
  await sleep(50);
  check(sam.count((f) => f.op === "deliver" && f.envelope.id === e2.id) === 0, "dropped message not delivered");
  const e3 = env("sam/worker", "alex/orchestrator");
  await alex.send({ op: "send", envelope: e3 });
  check(await alex.waitFor((f) => f.op === "rejected" && f.id === e3.id && f.reason === "from_mismatch"), "from another user -> from_mismatch");
  const e4 = env("alex/orchestrator", "Not An Address");
  await alex.send({ op: "send", envelope: e4 });
  check(await alex.waitFor((f) => f.op === "rejected" && f.id === e4.id && f.reason === "bad_address"), "bad to -> bad_address");

  console.error("broadcast + offline pending");
  const e5 = env("alex/orchestrator", "bob/worker", { body: { text: "first" } });
  const e6 = env("alex/orchestrator", "*", { type: "chat", body: "hello everyone" });
  await alex.send({ op: "send", envelope: e5 });
  await alex.send({ op: "send", envelope: e6 });
  await alex.waitFor((f) => f.op === "accepted" && f.id === e6.id);
  check(await sam.waitFor((f) => f.op === "deliver" && f.envelope.id === e6.id), "* reaches sam");
  await sleep(50);
  check(alex.count((f) => f.op === "deliver" && f.envelope.id === e6.id) === 0, "* skips sender's daemon");
  const bob = await daemon("bob");
  const bd = await bob.waitFor((f) => f.op === "deliver" && f.envelope.id === e6.id);
  const bobIds = bob.frames.filter((f) => f.op === "deliver").map((f: any) => f.envelope.id);
  check(bd && bobIds.indexOf(e5.id) === 0 && bobIds.indexOf(e6.id) === 1, "offline user gets pending deliveries in order on hello");
  bob.close();
  await alex.waitFor(isEvent("user.disconnected", (e) => e.user === "bob"));
  const bob2 = await daemon("bob");
  check(await bob2.waitFor((f) => f.op === "deliver" && f.envelope.id === e5.id), "unacked delivery resent on reconnect");
  await bob2.send({ op: "ack", id: e5.id });
  await bob2.send({ op: "ack", id: e6.id });
  await alex.waitFor(isEvent("message.delivered", (e) => e.id === e6.id && e.to === "bob/*"));
  const bob3 = await daemon("bob");
  check((await bob2.waitClose()) === 4003, "second daemon for same user closes the old one with 4003");
  await sleep(100);
  check(bob3.count((f) => f.op === "deliver") === 0, "acked deliveries not resent");

  console.error("context");
  const put = await api("/api/context/api-spec", { method: "PUT", body: JSON.stringify({ title: "API spec", kind: "api_spec", body: "# v1", author: "alex/orchestrator" }) });
  check(put.status === 200 && put.body.version === 1, "PUT context -> 200 version 1");
  check(await sam.waitFor(isEvent("context.updated", (e) => e.entry.key === "api-spec")), "context.updated event");
  const cu = await sam.waitFor<Extract<ServerFrame, { op: "deliver" }>>((f) => f.op === "deliver" && f.envelope.type === "context_update");
  check(cu && cu.envelope.to === "sam/*" && (cu.envelope.body as any).context_key === "api-spec", "daemon gets context_update deliver");
  if (cu) await sam.send({ op: "ack", id: cu.envelope.id });
  check(await sam.waitFor(isEvent("message.delivered", (e) => e.id === cu?.envelope.id)), "context_update ack -> delivered");
  const put2 = await api("/api/context/api-spec", { method: "PUT", body: JSON.stringify({ title: "API spec", kind: "api_spec", body: "# v2", author: "sam/worker", base_version: 1 }) });
  check(put2.status === 200 && put2.body.version === 2, "PUT with matching base_version -> version 2");
  const conflict = await api("/api/context/api-spec", { method: "PUT", body: JSON.stringify({ title: "x", kind: "note", body: "", author: "alex/orchestrator", base_version: 1 }) });
  check(conflict.status === 409 && conflict.body.error === "conflict" && conflict.body.current.version === 2, "stale base_version -> 409 with current");
  check((await api("/api/context/BAD KEY", { method: "PUT", body: JSON.stringify({ title: "x", kind: "note", body: "", author: "a/b" }) })).status === 400, "bad key -> 400");
  check((await api("/api/context?q=V2")).body.entries.length === 1, "GET /api/context?q= search");
  const del = await api("/api/context/api-spec?author=alex/orchestrator", { method: "DELETE" });
  check(del.status === 204 && (await alex.waitFor(isEvent("context.deleted", (e) => e.key === "api-spec"))), "DELETE -> 204 + context.deleted");

  console.error("REST queries + replay");
  const msgs = (await api("/api/messages?address=sam/worker")).body.messages as StoredMessage[];
  check(msgs.some((m) => m.id === e1.id) && msgs.some((m) => m.id === e6.id), "messages?address includes direct + * broadcast");
  const conv = (await api("/api/messages?address=alex/orchestrator&with=sam/worker")).body.messages as StoredMessage[];
  check(conv.some((m) => m.id === e1.id) && !conv.some((m) => m.id === e5.id), "messages?with narrows to conversation");
  const sessions = (await api("/api/sessions")).body.users;
  check(sessions.some((u: any) => u.user === "sam" && u.connected && u.sessions.length === 1), "GET /api/sessions");
  const events = (await api("/api/events?since=0&limit=5")).body.frames;
  check(events.length === 5 && events[0].seq === 1, "GET /api/events backfill");
  const uiSock = await ui("alex", 3);
  const replay = await uiSock.waitFor((f) => f.op === "event" && f.frame.seq === 4);
  check(replay, "since_seq replays events after snapshot");
  await uiSock.send({ op: "send", envelope: env("alex/human", "sam/worker") });
  check(await uiSock.waitFor((f) => f.op === "error" && f.code === "protocol"), "UI send -> error protocol");
  await uiSock.send({ op: "ping" });
  check(await uiSock.waitFor((f) => f.op === "pong"), "ping -> pong");
  const uiRest = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${uiSock.session}` } });
  check(uiRest.status === 200, "a ui socket's session works for REST too");

  console.error("message reads are scoped to the caller's user");
  {
    const asDave = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${daveUi.session}` } });
      return { status: r.status, body: r.status === 200 ? await r.json() : null };
    };
    const ids = (f: ServerFrame) => (f.op === "event" && "message" in f.frame.event ? (f.frame.event as any).message.id : f.op === "event" && "id" in f.frame.event ? (f.frame.event as any).id : null);
    const daveSaw = new Set(daveUi.frames.map(ids).filter(Boolean));
    check(!daveSaw.has(e1.id) && !daveSaw.has(e2.id) && !daveSaw.has(e5.id), "live message events between other users never reach dave's socket");
    check(daveSaw.has(e6.id), "dave's socket still gets the '*' broadcast");
    const sawSessions = daveUi.frames.some((f) => f.op === "event" && f.frame.event.type === "session.updated");
    check(sawSessions, "dave still gets session events (presence is shared)");
    const list = (await asDave("/api/messages?address=sam/worker")).body.messages as StoredMessage[];
    check(!list.some((m) => m.id === e1.id) && list.some((m) => m.id === e6.id), "GET /api/messages for someone else's address: only broadcasts");
    const all = (await asDave("/api/messages?limit=500")).body.messages as StoredMessage[];
    check(all.length > 0 && all.every((m) => m.from.startsWith("dave/") || m.to.startsWith("dave/") || m.to === "*"), "GET /api/messages with no filter: only dave's own and broadcasts");
    check((await asDave(`/api/messages/${e1.id}`)).status === 404, "GET /api/messages/:id of someone else's message -> 404");
    check((await asDave(`/api/messages/${e6.id}`)).status === 200, "GET /api/messages/:id of a broadcast -> 200");
    const frames = (await asDave("/api/events?since=0&limit=1000")).body.frames as any[];
    const evIds = new Set(frames.map((f) => f.event.message?.id ?? f.event.id).filter(Boolean));
    check(!evIds.has(e1.id) && !evIds.has(e5.id) && evIds.has(e6.id) && frames.some((f) => f.event.type === "user.connected"), "GET /api/events filters other users' message events, keeps the rest");
    const replayed = await ui("dave", 0);
    await sleep(100);
    const rIds = new Set(replayed.frames.map(ids).filter(Boolean));
    check(!rIds.has(e1.id) && rIds.has(e6.id), "since_seq replay is filtered the same way");
    replayed.close();
    const samSees = (await api(`/api/messages/${e1.id}`)).status;
    check(samSees === 200, "the sender (alex) still reads its own message");
  }

  console.error("heartbeat timeout + disconnect");
  check(await alex.waitFor(isEvent("session.updated", (e) => e.session.address === "sam/worker" && e.session.status === "offline"), 2000), "no heartbeat for timeout -> offline");
  await sam.send({ op: "heartbeat", agents: ["worker"] });
  check(await alex.waitFor(isEvent("session.updated", (e) => e.session.address === "sam/worker" && e.session.status === "idle" && alex.frames.length > 0)), "heartbeat brings session back");

  console.error("screens");
  {
    // the smoke hub times sessions out after 400ms; keep sam/worker alive until the offline check
    let beat = setInterval(() => void sam.send({ op: "heartbeat", agents: ["worker"] }), 100);
    const scr = (agent: string, text: string, extra: object = {}) => ({ op: "screen", screen: { agent, text, cols: 80, rows: 24, busy: false, ...extra } });
    const isScreen = (address: string, text?: string) => (f: ServerFrame) =>
      f.op === "screen" && f.address === address && (text === undefined || f.screen.text === text);
    const ui2 = await ui("alex");
    await ui2.send({ op: "screens.subscribe", addresses: ["sam/worker"] });
    await sam.send(scr("worker", "\u001b[32m$\u001b[0m hello"));
    const s1 = await ui2.waitFor<Extract<ServerFrame, { op: "screen" }>>(isScreen("sam/worker", "\u001b[32m$\u001b[0m hello"));
    check(s1 && s1.screen.cols === 80 && s1.screen.busy === false && typeof s1.at === "string", "daemon screen -> subscribed ui gets op screen");
    await sam.send(scr("worker", "\u001b[32m$\u001b[0m hello"));
    await sleep(100);
    check(ui2.count(isScreen("sam/worker")) === 1, "unchanged screen is not pushed again");
    await sam.send(scr("worker", "line 2", { busy: true }));
    check(await ui2.waitFor((f) => isScreen("sam/worker", "line 2")(f) && (f as any).screen.busy === true), "changed screen pushed");

    await alex.send(scr("ghost", "x"));
    check(await alex.waitFor((f) => f.op === "error" && /screen rejected: no session/.test(f.message)), "screen for an agent with no session -> rejected");
    await alex.send(scr("sam/worker", "spoof"));
    check(await alex.waitFor((f) => f.op === "error" && /screen rejected: bad agent/.test(f.message)), "screen naming another user's agent -> rejected");
    await sam.send(scr("worker", "x".repeat(64 * 1024 + 1)));
    check(await sam.waitFor((f) => f.op === "error" && /screen rejected: text over/.test(f.message)), "screen over SCREEN_MAX_BYTES -> rejected");
    await sam.send(scr("worker", "y", { cols: 0 }));
    check(await sam.waitFor((f) => f.op === "error" && /screen rejected: bad cols/.test(f.message)), "bad cols -> rejected");
    await sleep(50);
    check(!ui2.frames.some((f) => f.op === "screen" && (f.screen.text === "spoof" || f.screen.text.startsWith("xxx") || f.screen.text === "y")), "rejected screens never reach the ui");
    check([alex, sam, bob3].every((d) => d.count((f) => f.op === "screen" || f.op === "screen.gone") === 0), "daemons never get screens");
    await sam.send({ op: "screens.subscribe", addresses: "*" });
    check(await sam.waitFor((f) => f.op === "error" && f.code === "protocol"), "daemon screens.subscribe -> error protocol");

    const ui3 = await ui("sam");
    await sleep(50);
    check(ui3.count((f) => f.op === "screen") === 0, "no screens before subscribing");
    await ui3.send({ op: "screens.subscribe", addresses: "*" });
    check(await ui3.waitFor(isScreen("sam/worker", "line 2")), "subscribe '*' -> current screen sent immediately");
    await ui3.send({ op: "screens.subscribe", addresses: [] });
    await sleep(50);
    const before = ui3.count((f) => f.op === "screen");
    await sam.send(scr("worker", "line 3"));
    await ui2.waitFor(isScreen("sam/worker", "line 3"));
    await sleep(50);
    check(ui3.count((f) => f.op === "screen") === before, "subscribe [] replaces the earlier subscription");
    await ui3.send({ op: "screens.subscribe", addresses: ["Not An Address"] });
    check(await ui3.waitFor((f) => f.op === "error" && f.code === "bad_frame"), "bad subscribe list -> error bad_frame");

    const list = (await api("/api/screens")).body.screens;
    check(list.length === 1 && list[0].address === "sam/worker" && list[0].cols === 80 && !("text" in list[0]), "GET /api/screens lists screens without text");
    check((await fetch(`http://127.0.0.1:${port}/api/screens`)).status === 401, "GET /api/screens needs a session");

    await sam.send({ op: "session.remove", agent: "worker" });
    check(await ui2.waitFor((f) => f.op === "screen.gone" && f.address === "sam/worker"), "session.remove -> screen.gone");
    check((await api("/api/screens")).body.screens.length === 0, "removed session's screen is gone from /api/screens");
    await sam.send({ op: "session.upsert", session: { agent: "worker", kind: "worker", status: "idle", task: "" } });
    await sam.send(scr("worker", "back"));
    check(await ui2.waitFor(isScreen("sam/worker", "back")), "screen accepted again after re-upsert");
    clearInterval(beat);
    check(await ui2.waitFor((f) => f.op === "screen.gone" && f.address === "sam/worker" && ui2.count((g) => g.op === "screen.gone") === 2, 2000), "session offline (no heartbeat) -> screen.gone");
    await sam.send(scr("worker", "while offline"));
    check(await sam.waitFor((f) => f.op === "error" && /screen rejected: session offline/.test(f.message)), "screen for an offline session -> rejected");
    beat = setInterval(() => void sam.send({ op: "heartbeat", agents: ["worker"] }), 100);
    await sleep(150);
    clearInterval(beat);
    ui2.close();
    ui3.close();
  }

  console.error("REST session lifetime");
  {
    const live = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${alex.session}` } });
    check(live.status === 200, "session works while its socket is open");
    for (const c of [alex, sam, bob3, uiSock, daveUi]) c.close();
    await alex.waitClose();
    await sleep(100);
    const grace = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${alex.session}` } });
    check(grace.status === 200, "session still works right after the socket closes (grace)");
    await sleep(800); // restSessionGraceMs is 600 in this test (60s by default)
    const expired = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${alex.session}` } });
    check(expired.status === 401, "session expires after socket close + grace -> 401");
  }

  console.error("persistence across restart");
  const e7 = env("alex/orchestrator", "sam/worker");
  const alex2 = await daemon("alex");
  await alex2.send({ op: "send", envelope: e7 });
  await alex2.waitFor((f) => f.op === "accepted" && f.id === e7.id);
  alex2.close();
  await sleep(50);
  await hub.close();
  hub = new Hub(hubOpts);
  port = await hub.listen();
  const sam2 = await daemon("sam");
  const stale = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { Authorization: `Bearer ${alex2.session}` } });
  check(stale.status === 401, "a session from before a hub restart -> 401");
  bearer = sam2.session; // sessions are memory only: a restarted hub hands out new ones
  check(await sam2.waitFor((f) => f.op === "deliver" && f.envelope.id === e7.id), "pending delivery survives hub restart");
  check(((await api(`/api/messages/${e1.id}`)).body as StoredMessage).state === "delivered", "history survives restart");
  sam2.close();

  console.error("mdns failures are non-fatal");
  const healthOk = async () => (await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null))?.ok === true;
  const adv = new Advertiser({ name: `agentlink-smoke-${process.pid}`, port, hubId: hub.hubId, retryMs: 200 });
  adv.start();
  check(adv.starts === 1 && adv.bonjour, "advertiser publishes");
  const errno = (msg: string, code: string) => Object.assign(new Error(msg), { code });
  (adv.bonjour as any).server.mdns.emit("error", errno("bind EADDRINUSE 0.0.0.0:5353", "EADDRINUSE"));
  check(await healthOk(), "mdns socket 'error' event -> hub still answers /api/health");
  await sleep(400);
  check(adv.starts >= 2, "advertiser re-publishes after retry delay");
  (adv.bonjour as any).server.errorCallback(errno("send EHOSTUNREACH 224.0.0.251:5353", "EHOSTUNREACH"));
  check(await healthOk(), "bonjour errorCallback (EHOSTUNREACH) -> hub still answers /api/health");
  await sleep(400);
  check(adv.starts >= 3, "advertiser re-publishes after send failure");
  await adv.stop();
  installMdnsCrashGuard();
  const thrown = errno("send EHOSTUNREACH 224.0.0.251:5353", "EHOSTUNREACH");
  thrown.stack = "Error: send EHOSTUNREACH 224.0.0.251:5353\n    at Socket.<anonymous> (/x/node_modules/bonjour-service/dist/lib/mdns-server.js:16:91)";
  setTimeout(() => {
    throw thrown;
  }, 0);
  await sleep(100);
  check(await healthOk(), "uncaught error from bonjour stack -> logged, hub keeps serving");
  check(!isMdnsError(new Error("unrelated")), "crash guard only matches bonjour/multicast-dns stacks");

  console.error("the token never leaves the hub");
  const sent = allClients.flatMap((c) => c.raw);
  check(sent.length > 100 && !sent.some((r) => r.includes(TOKEN)), `no frame the hub sent contains the token (${sent.length} frames)`);
  const hubLog = readFileSync(process.env.AGENTLINK_HUB_LOG!, "utf8");
  check(!hubLog.includes(TOKEN) && !hubStdout.some((l) => l.includes(TOKEN)), "the token is in no hub log line (file or stdout)");
  check(hubStdout.some((l) => l.includes('"event":"auth.failed"')), "auth failures are logged (without the token)");
  check(!hubStdout.some((l) => allClients.some((c) => c.session && l.includes(c.session))), "REST sessions are never logged either");
} catch (err) {
  failures++;
  console.error("smoke test crashed:", err);
} finally {
  await hub.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.error(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
