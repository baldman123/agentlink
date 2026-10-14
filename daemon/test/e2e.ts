// End-to-end daemon test: a hub + two daemons (alex, sam) on test ports with throwaway DBs.
//   npm run test:e2e                      -> uses test/fake-hub.ts
//   HUB=real npm run test:e2e             -> starts ../hub (npm start) instead
// Ports: hub E2E_BASE (default 7790), alex +1, sam +2 (so it never collides with a dev setup on 7700-7702).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import type { ServerFrame } from "../../contracts/index.ts";

const TOKEN = "e2e-test-token";
const HUB_PORT = Number(process.env.E2E_BASE ?? 7790);
const PORTS = { alex: HUB_PORT + 1, sam: HUB_PORT + 2 } as const;
type User = keyof typeof PORTS;
const REAL = process.env.HUB === "real";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-e2e-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const procs: ChildProcess[] = [];
// Run node with the tsx loader directly (not the tsx wrapper), so SIGKILL hits the real process
// instead of orphaning a child that keeps the port.
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
}

function run(name: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const p = spawn(process.execPath, ["--import", TSX_LOADER, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const logFile = fs.createWriteStream(path.join(tmp, `${name}.out`), { flags: "a" });
  p.stdout!.pipe(logFile);
  p.stderr!.pipe(logFile);
  procs.push(p);
  return p;
}

/** `other` starts a different hub (new hub_id) on the same port, standing in for an impostor. */
function startHub(other = false) {
  if (REAL) {
    return run("hub", ["src/index.ts"], path.resolve(daemonDir, "../hub"), {
      AGENTLINK_TOKEN: TOKEN,
      AGENTLINK_HUB_PORT: String(HUB_PORT),
      AGENTLINK_HUB_DB: path.join(tmp, other ? "hub-other.sqlite" : "hub.sqlite"),
      AGENTLINK_MDNS: "0",
    });
  }
  return run("hub", ["test/fake-hub.ts"], daemonDir, {
    AGENTLINK_TOKEN: TOKEN,
    FAKE_HUB_PORT: String(HUB_PORT),
    FAKE_HUB_ID: other ? "fake-other" : "fake",
  });
}

function startDaemon(user: User, extraEnv: Record<string, string> = {}) {
  return run(user, [path.join(daemonDir, "src/index.ts")], tmp, {
    ...extraEnv,
    AGENTLINK_USER: user,
    AGENTLINK_TOKEN: TOKEN,
    AGENTLINK_HUB_URL: `http://127.0.0.1:${HUB_PORT}`,
    AGENTLINK_DISCOVERY: "manual",
    AGENTLINK_DAEMON_PORT: String(PORTS[user]),
    AGENTLINK_DAEMON_DB: path.join(tmp, `daemon-${user}.sqlite`),
  });
}

async function stop(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill(signal);
  await done;
}

async function api(user: User, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORTS[user]}${p}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

const health = (u: User) => api(u, "GET", "/v1/health").then((r) => r.body);
const connected = (u: User) => until(`${u} connected`, async () => (await health(u)).hub.state === "connected");
const inbox = (u: User, q = "") => api(u, "GET", `/v1/inbox${q}`).then((r) => r.body.messages as any[]);

/** Hub REST with the test token. */
async function hubApi(p: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${HUB_PORT}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return res.json();
}

/** A role=ui hub socket (real hub only), collecting server frames. */
class UiSock {
  frames: ServerFrame[] = [];
  private constructor(private ws: WebSocket) {
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
  }
  static async open(): Promise<UiSock> {
    const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/ws`);
    const sock = new UiSock(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send(JSON.stringify({ op: "hello", token: TOKEN, role: "ui", user: "e2e-ui", protocol: 1 }));
        resolve();
      });
      ws.once("error", reject);
    });
    await sock.wait((f) => f.op === "snapshot");
    return sock;
  }
  send(f: unknown) {
    this.ws.send(JSON.stringify(f));
  }
  wait<T extends ServerFrame>(pred: (f: any) => boolean, ms = 10_000): Promise<T | null> {
    return until("ui frame", async () => (this.frames.find(pred) as T | undefined) ?? null, ms).catch(() => null);
  }
  close() {
    this.ws.close();
  }
}

async function main() {
  console.log(`tmp dir: ${tmp}  hub: ${REAL ? "real" : "fake"}`);
  let hub = startHub();
  let alex = startDaemon("alex");
  let sam = startDaemon("sam");
  await connected("alex");
  await connected("sam");
  check("both daemons connected", true);

  const h = await health("alex");
  check("health shape", h.ok === true && h.user === "alex" && h.hub.via === "manual" && h.outbox_depth === 0, h);

  const sess = await api("sam", "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "idle", task: "" });
  check("PUT session", sess.status === 200 && sess.body.address === "sam/orchestrator", sess.body);

  // --- SSE on sam, then basic send alex -> sam/orchestrator
  const sseEvents: any[] = [];
  const sseReq = http.get(`http://127.0.0.1:${PORTS.sam}/v1/inbox/stream?agent=orchestrator`, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data) sseEvents.push(JSON.parse(data.slice(6)));
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300));

  const sent = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "task", body: "build the thing" });
  check("send -> 202", sent.status === 202 && sent.body.queued === true && typeof sent.body.id === "string", sent);
  const got = await until("sam receives", async () => (await inbox("sam", "?agent=orchestrator")).find((m) => m.envelope.id === sent.body.id));
  check("sam inbox has message", got.envelope.from === "alex/orchestrator" && got.envelope.hops === 1, got);
  check("remote flag true", got.remote === true, got);
  await until("alex outbox drained", async () => (await health("alex")).outbox_depth === 0);
  check("alex outbox drained after accepted", true);
  await until("SSE event", async () => sseEvents.some((e) => e.envelope.id === sent.body.id));
  check("SSE delivered the message", true);

  // broadcast sam/* shows under any agent filter
  const bc = await api("alex", "POST", "/v1/send", { to: "sam/*", type: "chat", body: { text: "hello all" } });
  await until("broadcast", async () => (await inbox("sam", "?agent=worker-9")).some((m) => m.envelope.id === bc.body.id));
  check("sam/* lands in every agent's view", true);

  // ack / unhandled
  const ack = await api("sam", "POST", `/v1/inbox/${sent.body.id}/ack`);
  check("ack -> 204", ack.status === 204, ack);
  const unhandled = await inbox("sam", "?agent=orchestrator&unhandled=1");
  check("acked message filtered by unhandled=1", !unhandled.some((m) => m.envelope.id === sent.body.id), unhandled);

  // validation
  check("hops 6 -> 422", (await api("alex", "POST", "/v1/send", { to: "sam/x", type: "chat", body: "x", hops: 6 })).status === 422);
  check("bad address -> 400", (await api("alex", "POST", "/v1/send", { to: "Sam", type: "chat", body: "x" })).status === 400);
  check("bad type -> 400", (await api("alex", "POST", "/v1/send", { to: "sam/x", type: "nope", body: "x" })).status === 400);

  // CORS
  const cors = await api("alex", "GET", "/v1/health", undefined, { origin: "http://localhost:5173" });
  check("CORS localhost origin allowed", cors.headers.get("access-control-allow-origin") === "http://localhost:5173");
  const evil = await api("alex", "GET", "/v1/health", undefined, { origin: "http://evil.example" });
  check("foreign origin -> 403", evil.status === 403, evil.body);
  const boot = await api("alex", "GET", "/v1/ui-bootstrap");
  check("ui-bootstrap", boot.body.hub_ws === `ws://127.0.0.1:${HUB_PORT}/ws` && boot.body.token === TOKEN, boot.body);

  // context proxy
  const ctx = await api("alex", "PUT", "/v1/context/api.users", { title: "Users API", kind: "api_spec", body: "GET /users" });
  check("context PUT proxied with author", ctx.status === 200 && ctx.body.author === "alex/orchestrator", ctx.body);
  const ctxGet = await api("sam", "GET", "/v1/context/api.users");
  check("context GET proxied", ctxGet.status === 200 && ctxGet.body.version === 1, ctxGet.body);
  const peers = await api("alex", "GET", "/v1/peers");
  check("peers proxied", peers.status === 200 && Array.isArray(peers.body.users), peers.body);

  // rejected path (fake hub only)
  if (!REAL) {
    const rej = await api("alex", "POST", "/v1/send", { from_agent: "worker-1", to: "reject/me", type: "chat", body: "x" });
    const note = await until("rejection note", async () =>
      (await inbox("alex", "?agent=worker-1")).find((m) => m.envelope.reply_to === rej.body.id),
    );
    check("rejected -> status note in sender inbox", note.envelope.type === "status" && note.envelope.body.text === "bad_address", note);
  }

  // --- recipient down: message waits at the hub, delivered after sam restarts
  sseReq.destroy();
  await stop(sam);
  const whileDown = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "task", body: "while you were out" });
  await until("accepted while sam down", async () => (await health("alex")).outbox_depth === 0);
  sam = startDaemon("sam");
  await until("sam gets queued message after restart", async () =>
    (await inbox("sam")).some((m) => m.envelope.id === whileDown.body.id),
  );
  check("recipient restart: pending delivery arrives", true);

  // --- sender's outbox survives hub outage + daemon restart
  await stop(hub);
  await until("alex notices hub gone", async () => (await health("alex")).hub.state !== "connected");
  const ctxDown = await api("alex", "PUT", "/v1/context/x", { title: "x", kind: "note", body: "x" });
  check("context PUT while offline -> 503", ctxDown.status === 503 && ctxDown.body.error === "hub_offline", ctxDown.body);
  const queued = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "task", body: "queued during outage" });
  const ob = await api("alex", "GET", "/v1/outbox");
  check("message sits in outbox", ob.body.items.some((i: any) => i.envelope.id === queued.body.id), ob.body);
  await stop(alex, "SIGKILL");
  const portFree = await health("alex").then(() => false, () => true);
  check("killed daemon's port is closed", portFree);
  alex = startDaemon("alex");
  await until("alex back up", async () => (await health("alex")).outbox_depth === 1);
  check("outbox survived kill -9", true);
  hub = startHub();
  await until("queued message delivered after reconnect", async () =>
    (await inbox("sam")).some((m) => m.envelope.id === queued.body.id),
  30_000);
  check("outbox flushed after reconnect, delivered to sam", true);
  check("alex outbox empty", (await health("alex")).outbox_depth === 0);

  // dedupe: inbox has each id exactly once
  const all = await inbox("sam", "?limit=1000");
  const ids = all.map((m) => m.envelope.id);
  check("inbox dedupe", ids.length === new Set(ids).size, ids);

  // --- screens (screens.md): local API, forwarding, latest-only while offline, never queued
  {
    const scr = (text: string, extra: object = {}) => ({ agent: "worker-1", text, cols: 80, rows: 24, busy: false, ...extra });
    await api("alex", "PUT", "/v1/sessions/worker-1", { kind: "worker", status: "working", task: "" });
    let ui: UiSock | null = null;
    if (REAL) {
      ui = await UiSock.open();
      ui.send({ op: "screens.subscribe", addresses: ["alex/worker-1"] });
    }
    const put1 = await api("alex", "PUT", "/v1/screens/worker-1", scr("\u001b[32mone\u001b[0m", { busy: true }));
    check("PUT /v1/screens/:agent -> 204", put1.status === 204, put1);
    const got = await api("alex", "GET", "/v1/screens/worker-1");
    check("GET /v1/screens/:agent returns the latest", got.status === 200 && got.body.text === "\u001b[32mone\u001b[0m" && got.body.busy === true && typeof got.body.at === "string", got.body);
    check("GET unknown screen -> 404", (await api("alex", "GET", "/v1/screens/worker-9")).status === 404);
    check("oversized screen -> 413", (await api("alex", "PUT", "/v1/screens/worker-1", scr("x".repeat(64 * 1024 + 1)))).status === 413);
    check("bad cols -> 400", (await api("alex", "PUT", "/v1/screens/worker-1", scr("x", { cols: 0 }))).status === 400);
    check("body agent differing from path -> 400", (await api("alex", "PUT", "/v1/screens/worker-1", { ...scr("x"), agent: "worker-2" })).status === 400);
    const cors = await api("alex", "PUT", "/v1/screens/worker-1", scr("two"), { origin: "http://evil.example" });
    check("screens API refuses foreign origins (403)", cors.status === 403);
    await api("alex", "PUT", "/v1/screens/worker-1", scr("two"));
    if (REAL) {
      check("hub pushes the screen to a subscribed ui", !!(await ui!.wait((f) => f.op === "screen" && f.address === "alex/worker-1" && f.screen.text === "two")));
    } else {
      const seen = await until("fake hub got screen", async () => {
        const rec = (await hubApi("/api/fake-screens"))["alex/worker-1"];
        return rec?.texts.includes("two") ? rec : null;
      });
      check("daemon forwards {op:screen} while connected", seen.texts.at(-1) === "two", seen);
    }

    // hub down: only the latest screen per agent survives, nothing is queued
    await stop(hub);
    ui?.close();
    await until("alex disconnected", async () => (await health("alex")).hub.state !== "connected");
    for (const t of ["three", "four", "five"]) await api("alex", "PUT", "/v1/screens/worker-1", scr(t));
    check("screens are not queued in the outbox", (await health("alex")).outbox_depth === 0);
    const dbBytes = fs.readFileSync(path.join(tmp, "daemon-alex.sqlite"));
    const wal = path.join(tmp, "daemon-alex.sqlite-wal");
    const walBytes = fs.existsSync(wal) ? fs.readFileSync(wal) : Buffer.alloc(0);
    check("screens are not written to SQLite", !dbBytes.includes("five") && !walBytes.includes("five"));
    hub = startHub();
    await connected("alex");
    if (REAL) {
      ui = await UiSock.open();
      ui.send({ op: "screens.subscribe", addresses: ["alex/worker-1"] });
      const s = await ui.wait<Extract<ServerFrame, { op: "screen" }>>((f) => f.op === "screen" && f.address === "alex/worker-1");
      check("after reconnect the hub has the latest screen", s?.screen.text === "five", s);
    } else {
      const rec = await until("fake hub got resent screen", async () => (await hubApi("/api/fake-screens"))["alex/worker-1"] ?? null);
      await new Promise((r) => setTimeout(r, 500));
      const rec2 = (await hubApi("/api/fake-screens"))["alex/worker-1"];
      check("on reconnect only the latest screen is sent (once)", rec2.count === 1 && rec2.texts[0] === "five", { rec, rec2 });
    }

    const del = await api("alex", "DELETE", "/v1/screens/worker-1");
    check("DELETE /v1/screens/:agent -> 204, then GET 404", del.status === 204 && (await api("alex", "GET", "/v1/screens/worker-1")).status === 404);
    if (REAL) {
      await api("alex", "PUT", "/v1/screens/worker-1", scr("six"));
      await ui!.wait((f) => f.op === "screen" && f.address === "alex/worker-1" && f.screen.text === "six");
      await api("alex", "DELETE", "/v1/sessions/worker-1");
      check("removing the session -> screen.gone at the ui", !!(await ui!.wait((f) => f.op === "screen.gone" && f.address === "alex/worker-1")));
      ui!.close();
    } else {
      await api("alex", "DELETE", "/v1/sessions/worker-1");
    }
  }

  // rejection note is logged (fake hub only; it's the one with the reject hook)
  if (!REAL) {
    const lines = fs.readFileSync(path.join(tmp, "logs", "daemon-alex.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    check(
      "rejection note logged as msg.received local",
      lines.some((l) => l.event === "msg.received" && l.local === true && l.reason === "bad_address" && l.from === "alex/agentlink"),
    );
  }

  // --- hub_id pin: a different hub on the same address is refused before the token is sent
  await stop(hub);
  hub = startHub(true);
  const alexLog = path.join(tmp, "logs", "daemon-alex.log");
  const idChanged = await until("hub.id_changed in alex's log", async () =>
    fs.readFileSync(alexLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.event === "hub.id_changed"),
  20_000);
  check("pinned daemon logs hub.id_changed for a new hub_id", idChanged.got_hub_id !== idChanged.expected_hub_id, idChanged);
  check("mismatch caught at precheck, before the token was sent", idChanged.stage === "precheck", idChanged);
  await new Promise((r) => setTimeout(r, 1500));
  check("pinned daemon stays offline", (await health("alex")).hub.state === "offline");

  await stop(alex);
  alex = startDaemon("alex", { AGENTLINK_HUB_REPIN: "1" });
  await connected("alex");
  const repinned = fs.readFileSync(alexLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((l) => l.event === "hub.repinned");
  check("AGENTLINK_HUB_REPIN=1 re-pins and connects", repinned);
}

main()
  .catch((err) => {
    failures++;
    console.log(`FAIL  ${err.message}`);
  })
  .finally(async () => {
    await Promise.all(procs.map((p) => stop(p)));
    console.log(failures ? `\n${failures} failure(s). logs in ${tmp}` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
