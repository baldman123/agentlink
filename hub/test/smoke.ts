// Smoke test: runs an in-process hub on a random port with a temp DB and drives it with fake daemon sockets.
// Run: npm test (from hub/), or: npx tsx test/smoke.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Envelope, ServerFrame, StoredMessage } from "../../contracts/index.ts";
import { PROTOCOL_VERSION } from "../../contracts/index.ts";

process.env.AGENTLINK_HUB_LOG ??= join(mkdtempSync(join(tmpdir(), "agentlink-hub-log-")), "hub.log");
const { Hub } = await import("../src/hub.ts");
const { Advertiser, installMdnsCrashGuard, isMdnsError } = await import("../src/mdns.ts");

const TOKEN = "smoke-token";
const dir = mkdtempSync(join(tmpdir(), "agentlink-hub-"));
const dbPath = join(dir, "hub.sqlite");
const hubOpts = { port: 0, host: "127.0.0.1", token: TOKEN, dbPath, hubName: "smoke", helloTimeoutMs: 300, sweepIntervalMs: 100, sessionTimeoutMs: 400 };
let hub = new Hub(hubOpts);
let port = await hub.listen();

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

class Client {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  closeCode: number | null = null;
  opened: Promise<void>;
  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    this.ws.on("close", (code) => (this.closeCode = code));
    this.opened = new Promise((r) => this.ws.once("open", () => r()));
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
  await c.send({ op: "hello", token: TOKEN, role: "daemon", user, protocol: PROTOCOL_VERSION, since_seq });
  await c.waitFor((f) => f.op === "snapshot");
  return c;
}

function env(from: string, to: string, extra: Partial<Envelope> = {}): Envelope {
  return { id: randomUUID(), from, to, reply_to: null, hops: 0, type: "task", body: "do the thing", timestamp: new Date().toISOString(), ...extra };
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

try {
  console.error("auth");
  {
    const bad = new Client();
    await bad.send({ op: "hello", token: "wrong", role: "daemon", user: "eve", protocol: PROTOCOL_VERSION });
    check(await bad.waitFor((f) => f.op === "error" && f.code === "auth_failed"), "wrong token -> error auth_failed");
    check((await bad.waitClose()) === 4001, "wrong token -> close 4001");
    const silent = new Client();
    await silent.opened;
    check((await silent.waitClose(5000)) === 4001, "no hello within timeout -> close 4001");
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
    check(health.ok && health.hub_name === "smoke", "GET /api/health open without token");
    const landing = await fetch(`http://127.0.0.1:${port}/`);
    const html = await landing.text();
    check(landing.status === 200 && (landing.headers.get("content-type") ?? "").startsWith("text/html"), "GET / -> 200 text/html without token");
    check(html.includes("agentlink hub · smoke") && html.includes("not the app") && !html.includes(TOKEN), "landing page names the hub, explains itself, never shows the token");
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    check(noAuth.status === 401, "REST without token -> 401");
  }

  console.error("handshake + sessions");
  const alex = await daemon("alex");
  check(alex.frames[0]?.op === "welcome" && alex.frames[1]?.op === "snapshot", "welcome then snapshot");
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
  const ui = new Client();
  await ui.send({ op: "hello", token: TOKEN, role: "ui", user: "alex", protocol: PROTOCOL_VERSION, since_seq: 3 });
  await ui.waitFor((f) => f.op === "snapshot");
  const replay = await ui.waitFor((f) => f.op === "event" && f.frame.seq === 4);
  check(replay, "since_seq replays events after snapshot");
  await ui.send({ op: "send", envelope: env("alex/human", "sam/worker") });
  check(await ui.waitFor((f) => f.op === "error" && f.code === "protocol"), "UI send -> error protocol");
  await ui.send({ op: "ping" });
  check(await ui.waitFor((f) => f.op === "pong"), "ping -> pong");

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
    const ui2 = new Client();
    await ui2.send({ op: "hello", token: TOKEN, role: "ui", user: "alex", protocol: PROTOCOL_VERSION });
    await ui2.waitFor((f) => f.op === "snapshot");
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

    const ui3 = new Client();
    await ui3.send({ op: "hello", token: TOKEN, role: "ui", user: "sam", protocol: PROTOCOL_VERSION });
    await ui3.waitFor((f) => f.op === "snapshot");
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
    check((await fetch(`http://127.0.0.1:${port}/api/screens`)).status === 401, "GET /api/screens needs the token");

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

  console.error("persistence across restart");
  for (const c of [alex, sam, bob3, ui]) c.close();
  await sleep(100);
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
} catch (err) {
  failures++;
  console.error("smoke test crashed:", err);
} finally {
  await hub.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.error(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
