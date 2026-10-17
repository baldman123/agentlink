// End-to-end test of the daemon's cloud hub link (src/cloudlink.ts, contracts/cloud-api.md) against a
// fake website API and a fake Supabase Realtime (fake-cloud.ts, fake-realtime.ts), both in-process.
// The daemon runs as a real child process on 7771 (7772 for a second one) with a throwaway DB.
// AGENTLINK_HUB_MODE=cloud because the fake serves http (a real site is https://, which picks cloud by itself).
//
// Run: npx tsx test/cloud-e2e.ts   (from daemon/)
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonHealth, Envelope, InboxItem } from "../../contracts/index.ts";
import { startFakeCloud, type FakeCloud } from "./fake-cloud.ts";

const PORT = 7771;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cloud-e2e-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
const procs: ChildProcess[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms = 8_000, step = 50): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}

function startDaemon(cloud: FakeCloud, opts: { code?: string; port?: number; db?: string; user?: string } = {}) {
  const port = opts.port ?? PORT;
  const user = opts.user ?? "alex";
  // cwd is the temp dir, so the daemon's ./logs land there and not in the repo
  const p = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: tmp,
    env: {
      ...process.env,
      AGENTLINK_USER: user,
      AGENTLINK_TOKEN: opts.code ?? "code-alex",
      AGENTLINK_HUB_URL: cloud.url,
      AGENTLINK_HUB_MODE: "cloud",
      AGENTLINK_DAEMON_PORT: String(port),
      AGENTLINK_DAEMON_DB: opts.db ?? path.join(tmp, `${user}.sqlite`),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(path.join(tmp, `daemon-${user}-${port}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}
async function stopDaemon(p: ChildProcess) {
  if (p.exitCode !== null) return;
  p.kill("SIGTERM");
  await until(() => p.exitCode !== null, 3_000);
  if (p.exitCode === null) p.kill("SIGKILL");
}

const api = async (method: string, p: string, body?: unknown, port = PORT) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const health = async (port = PORT) => (await api("GET", "/v1/health", undefined, port).catch(() => null))?.body as DaemonHealth | null;
const state = async (port = PORT) => (await health(port))?.hub.state;
const inbox = async (port = PORT) => ((await api("GET", "/v1/inbox?limit=1000", undefined, port)).body as { messages: InboxItem[] }).messages;
const sinceOf = (p: string) => Number(new URL(p, "http://x").searchParams.get("since_seq"));
const env = (from: string, to: string, text: string, hops = 1): Envelope => ({
  id: randomUUID(), from, to, reply_to: null, hops, type: "chat", body: text, timestamp: new Date().toISOString(),
});

/** A stand-in for the c4 bridge: reads the daemon's input stream (input.md) and reports `sent` for every pane. */
function fakeBridge(port = PORT) {
  const got: Array<{ id: string; agents: string[]; text: string; submit: boolean }> = [];
  const req = http.get({ host: "127.0.0.1", port, path: "/v1/panes/input/stream" }, (res) => {
    let buf = "";
    res.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!/^event: input$/m.test(block) || !data) continue;
        const f = JSON.parse(data);
        got.push(f);
        void api("POST", `/v1/panes/input/${f.id}/result`, { results: Object.fromEntries(f.agents.map((a: string) => [a, a === "worker-2" ? "skipped: prompt_open" : "sent"])) }, port);
      }
    });
  });
  req.on("error", () => {});
  return { got, close: () => req.destroy() };
}

async function main() {
  // ---------------------------------------------------------------- wrong code
  {
    const cloud = await startFakeCloud();
    const d = startDaemon(cloud, { code: "wrong", db: path.join(tmp, "wrong.sqlite") });
    const st = await until(async () => ((await state()) === "offline" ? "offline" : null));
    check("a wrong access code leaves the daemon offline", st === "offline", await health());
    check("with a wrong code nothing but login is called", cloud.requests.every((r) => r.path === "/api/auth/login"), cloud.requests.map((r) => r.path));
    check("with a wrong code no Realtime channel is joined", cloud.rt.joins().length === 0);
    check("the access code is sent only in the login body", cloud.requests.every((r) => r.bearer !== "wrong"));
    await stopDaemon(d);
    await cloud.close();
  }

  // ---------------------------------------------------------------- main flow
  const cloud = await startFakeCloud({ jwtTtlMs: 3_000 }); // short JWT so the refresh happens during the test
  let d = startDaemon(cloud);
  await until(async () => (await api("GET", "/v1/health").catch(() => null))?.status === 200);
  // sessions registered before the hub link is up go out on connect
  await api("PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "working", task: "plan" });
  await api("PUT", "/v1/sessions/worker-1", { kind: "worker", status: "idle", task: "" });
  const connected = await until(async () => ((await state()) === "connected" ? true : null));
  check("logs in with the access code and connects", !!connected, await health());
  const h = await health();
  check("health reports the website as the hub (via manual, name from login)", h?.hub.url === cloud.url && h?.hub.via === "manual" && h?.hub.hub_name === "agentlink cloud (fake)", h?.hub);
  const boot = (await api("GET", "/v1/ui-bootstrap")).body as { hub_http: string | null; hub_ws: string | null };
  check("ui-bootstrap: hub_http is the website, no hub_ws", boot.hub_http === cloud.url && boot.hub_ws === null, boot);

  const joins = cloud.rt.joins();
  const dj = joins.find((j) => j.topic === "realtime:deliveries:alex");
  check("joins the deliveries channel with the minted JWT", !!dj && /^jwt-alex-/.test(dj.token ?? ""), joins);
  check("deliveries binding is INSERT on public.deliveries filtered to this user", !!dj && dj.pg.length === 1 && dj.pg[0].table === "deliveries" && dj.pg[0].filter === "username=eq.alex" && dj.pg[0].event === "INSERT", dj?.pg);
  check("joins user:alex (the revoke kick), screens (watchers) and input:alex", ["realtime:user:alex", "realtime:screens", "realtime:input:alex"].every((t) => joins.some((j) => j.topic === t)), joins.map((j) => j.topic));
  check("joins no other user's input channel", !joins.some((j) => j.topic.startsWith("realtime:input:") && j.topic !== "realtime:input:alex"));
  check("tracks itself on presence as {user, kind: daemon}", !!(await until(() => (cloud.rt.tracked()["realtime:presence"]?.alex as { kind?: string } | undefined)?.kind === "daemon")), cloud.rt.tracked());
  check("does not track itself as a screens watcher", !cloud.rt.tracked()["realtime:screens"]);
  check("pushes its sessions on connect", cloud.agentSessions.get("alex/orchestrator")?.task === "plan" && cloud.agentSessions.has("alex/worker-1"), [...cloud.agentSessions.keys()]);
  check("every call after login carries the session as a bearer", cloud.requests.filter((r) => r.path !== "/api/auth/login").every((r) => /^sess-alex-/.test(r.bearer ?? "")));
  check("sends a heartbeat", !!(await until(() => cloud.heartbeats > 0)));

  // session changes while connected
  await api("PUT", "/v1/sessions/worker-1", { kind: "worker", status: "working", task: "tests" });
  check("a session change is PUT right away", !!(await until(() => cloud.agentSessions.get("alex/worker-1")?.status === "working")));
  await api("PUT", "/v1/sessions/worker-9", { kind: "worker", status: "idle", task: "" });
  await until(() => cloud.agentSessions.has("alex/worker-9"));
  await api("DELETE", "/v1/sessions/worker-9");
  check("a removed session is DELETEd", !!(await until(() => !cloud.agentSessions.has("alex/worker-9"))));

  // send: accepted
  const s1 = await api("POST", "/v1/send", { from_agent: "orchestrator", to: "sam/orchestrator", type: "task", body: "schema please" });
  check("POST /v1/send queues (202)", s1.status === 202, s1);
  const sentId = (s1.body as { id: string }).id;
  check("the envelope reaches POST /api/messages", !!(await until(() => cloud.sent.find((e) => e.id === sentId))));
  check("an accepted message leaves the outbox", !!(await until(async () => ((await api("GET", "/v1/outbox")).body.items.length === 0 ? true : null))));

  // send: rejected -> local status note
  const s2 = await api("POST", "/v1/send", { from_agent: "orchestrator", to: "nobody/orchestrator", type: "chat", body: "hello?" });
  const rid = (s2.body as { id: string }).id;
  const note = await until(async () => (await inbox()).find((i) => i.envelope.type === "status" && (i.envelope.body as { rejected_id?: string }).rejected_id === rid));
  check("a rejected message comes back as a status note with the reason", !!note && /unknown_target/.test(String((note!.envelope.body as { text?: string }).text)), note);
  check("a rejected message leaves the outbox", (await api("GET", "/v1/outbox")).body.items.length === 0);

  // delivery over Realtime
  const in1 = env("sam/orchestrator", "alex/orchestrator", "here is the schema");
  const seq1 = cloud.deliver("alex", in1);
  const got1 = await until(async () => (await inbox()).find((i) => i.envelope.id === in1.id));
  check("a Realtime delivery lands in the inbox", !!got1, got1);
  check("it is marked remote (another user)", got1?.remote === true);
  check("the delivery is acked", !!(await until(() => cloud.acked.has(in1.id))));
  // the same row again (Realtime and a resume can overlap): stored once
  cloud.rt.insert("deliveries", { seq: seq1, message_id: in1.id, username: "alex", hops: in1.hops, envelope: in1 });
  await sleep(400);
  check("a duplicate delivery is stored once", (await inbox()).filter((i) => i.envelope.id === in1.id).length === 1);
  // someone else's row never reaches us (the binding filters on to_user)
  const other = env("alex/orchestrator", "sam/orchestrator", "not for alex");
  cloud.deliver("sam", other);
  await sleep(400);
  check("a delivery for another user is not received", !(await inbox()).some((i) => i.envelope.id === other.id));
  // hop limit
  const hot = env("sam/orchestrator", "alex/worker-1", "loop", 99);
  cloud.deliver("alex", hot);
  check("a delivery over the hop limit is acked but not stored", !!(await until(() => cloud.acked.has(hot.id))) && !(await inbox()).some((i) => i.envelope.id === hot.id));

  // JWT refresh (TTL 3s -> refresh at ~2s), pushed to Realtime as access_token
  const pushed = await until(() => cloud.rt.tokenPushes().find((t) => /^jwt-alex-/.test(t)), 6_000);
  check("refreshes the Realtime JWT before it expires and pushes it to the socket", !!pushed && cloud.requests.some((r) => r.path === "/api/auth/refresh"), { pushes: cloud.rt.tokenPushes() });
  check("still connected after the refresh", (await state()) === "connected");

  // the session expires server-side: the next call gets 401, the daemon logs in again and retries it
  cloud.expireSessions();
  const logins = cloud.requests.filter((r) => r.path === "/api/auth/login").length;
  const s3 = await api("POST", "/v1/send", { from_agent: "orchestrator", to: "sam/orchestrator", type: "chat", body: "after expiry" });
  const id3 = (s3.body as { id: string }).id;
  check("after a 401 it logs in again and the message still goes out", !!(await until(() => cloud.sent.find((e) => e.id === id3))) && cloud.requests.filter((r) => r.path === "/api/auth/login").length > logins);

  // proxied REST reads use the session
  const peers = await api("GET", "/v1/peers");
  check("GET /v1/peers is proxied to /api/sessions with the session", peers.status === 200 && Array.isArray((peers.body as { users: unknown[] }).users), peers);

  // Realtime drops; deliveries made meanwhile come back through the resume from last_seq
  cloud.rt.dropAll();
  const missed = env("sam/worker-3", "alex/worker-1", "while you were away");
  await sleep(200);
  cloud.deliver("alex", missed, false); // stored, never pushed
  const back = await until(async () => (await inbox()).find((i) => i.envelope.id === missed.id), 15_000);
  check("after Realtime reconnects, a delivery missed meanwhile is fetched (resume)", !!back);
  const resumeCalls = cloud.requests.filter((r) => r.path.startsWith("/api/deliveries?since_seq="));
  check("the resume asks for since_seq > 0 (the stored last seq)", resumeCalls.some((r) => sinceOf(r.path) > 0), resumeCalls.map((r) => r.path));
  check("connected again after the Realtime drop", !!(await until(async () => ((await state()) === "connected" ? true : null), 10_000)));

  // the API goes down: messages wait in the outbox, in order, and go out when it is back
  cloud.failNext = 4;
  const q1 = await api("POST", "/v1/send", { from_agent: "orchestrator", to: "sam/orchestrator", type: "chat", body: "q1" });
  const q2 = await api("POST", "/v1/send", { from_agent: "orchestrator", to: "sam/orchestrator", type: "chat", body: "q2" });
  const ids = [(q1.body as { id: string }).id, (q2.body as { id: string }).id];
  const both = await until(() => ids.every((id) => cloud.sent.some((e) => e.id === id)), 20_000);
  check("messages sent while the API answers 503 go out once it recovers", !!both);
  const order = cloud.sent.map((e) => e.id).filter((id) => ids.includes(id));
  check("...in the order they were sent", order[0] === ids[0] && order[1] === ids[1], order);

  // screens: nothing while nobody watches, then at most one per pane per 3s
  for (let i = 0; i < 5; i++) await api("PUT", "/v1/screens/worker-1", { text: `frame ${i}`, cols: 80, rows: 24 });
  await sleep(800);
  check("no screen is sent while nobody is watching", cloud.screens.length === 0, cloud.screens.length);
  // someone watching only another pane doesn't count for worker-1
  cloud.rt.setPresence("realtime:screens", { "sam:a1": [{ user: "sam", watching: ["alex/worker-2", "sam/*"] }] });
  await sleep(1_000);
  check("a watcher of another pane doesn't make worker-1 publish", cloud.screens.length === 0, cloud.screens.length);
  cloud.rt.setPresence("realtime:screens", { "sam:a1": [{ user: "sam", watching: ["alex/worker-1"] }] });
  const first = await until(() => cloud.screens[0], 5_000);
  check("a watcher appears: the latest screen is sent", !!first && first.screen.text === "frame 4", first?.screen.text);
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000) {
    await api("PUT", "/v1/screens/worker-1", { text: `burst ${Date.now()}`, cols: 80, rows: 24 });
    await sleep(100);
  }
  const w1 = cloud.screens.filter((s) => s.screen.agent === "worker-1");
  const gaps = w1.slice(1).map((s, i) => s.at - w1[i].at);
  check("screens are throttled to one per pane per 3s", w1.length >= 2 && w1.length <= 3 && gaps.every((g) => g >= 2_900), { n: w1.length, gaps });
  cloud.rt.setPresence("realtime:screens", { "alex:daemon": [{ user: "alex", watching: "*" }] }); // only this daemon's own key left
  await sleep(3_500);
  const n0 = cloud.screens.length;
  await api("PUT", "/v1/screens/worker-1", { text: "nobody", cols: 80, rows: 24 });
  await sleep(3_500);
  check("screens stop when the last watcher leaves (its own key doesn't count)", cloud.screens.length === n0, cloud.screens.length - n0);
  cloud.rt.setPresence("realtime:screens", { "bryant:x9": [{ user: "bryant", watching: "*" }] });
  await until(() => cloud.screens.length > n0, 5_000);
  await api("DELETE", "/v1/screens/worker-1");
  check("a removed screen is announced with POST /api/screens/gone", !!(await until(() => cloud.screensGone.includes("worker-1"))), cloud.screensGone);

  // ---------------------------------------------------------------- typing into own panes from the website
  {
    const noBridge = cloud.sendInput("alex", ["worker-1"], "echo early");
    const nb = await until(() => (cloud.inputs.get(noBridge)?.state === "failed" ? cloud.inputs.get(noBridge) : null));
    check("no bridge connected: the input is reported failed: no_bridge right away", nb?.results?.["worker-1"] === "failed: no_bridge", nb);
    const bridge = fakeBridge();
    await until(async () => (await sleep(300), true));
    const id1 = cloud.sendInput("alex", ["orchestrator", "worker-2"], "plan the release", { submit: true });
    const typed = await until(() => bridge.got.find((g) => g.text === "plan the release"));
    check("a signed input frame reaches the bridge like a local command-bar request", !!typed && typed.agents.join() === "orchestrator,worker-2" && typed.submit === true, typed);
    const res1 = await until(() => (cloud.inputs.get(id1)?.state === "done" ? cloud.inputs.get(id1) : null));
    check("the bridge's per-pane results go back to POST /api/panes/input/:id/result", res1?.results?.orchestrator === "sent" && res1?.results?.["worker-2"] === "skipped: prompt_open", res1);

    const before = bridge.got.length;
    const refused: Array<[string, () => string]> = [
      ["a frame whose text was changed after signing", () => cloud.sendInput("alex", ["worker-1"], "ls", { tamper: (f) => (f.text = "rm -rf ~") })],
      ["a frame signed with someone else's code", () => cloud.sendInput("alex", ["worker-1"], "whoami", { signAs: "sam" })],
      ["a frame for another user (validly signed by them) sent on our channel", () => cloud.sendInput("sam", ["worker-1"], "hi", { channelUser: "alex" })],
      ["a frame with our signature but another user in it", () => cloud.sendInput("sam", ["worker-1"], "hi", { channelUser: "alex", signAs: "alex" })],
      ["a frame 2 minutes old", () => cloud.sendInput("alex", ["worker-1"], "late", { at: new Date(Date.now() - 120_000).toISOString() })],
      ["a frame for a pane outside the five", () => cloud.sendInput("alex", ["worker-9"], "x")],
      ["a frame with no sig", () => cloud.sendInput("alex", ["worker-1"], "x", { tamper: (f) => delete f.sig })],
    ];
    cloud.codes.set("sam", "code-sam");
    for (const [, fire] of refused) fire();
    // a replay of an accepted frame (same id, same signature): the gate remembers ids
    const replayId = cloud.sendInput("alex", ["worker-3"], "once only");
    await until(() => bridge.got.some((g) => g.text === "once only"));
    cloud.sendInput("alex", ["worker-3"], "once only", { id: replayId, at: bridge.got.length ? new Date().toISOString() : undefined });
    await sleep(1_000);
    const extra = bridge.got.slice(before).map((g) => g.text);
    check("refused: tampered text, another person's signature, another user, stale, bad pane, no sig", !extra.some((t) => ["ls", "rm -rf ~", "whoami", "hi", "late", "x"].includes(t)), extra);
    check("a replayed frame is typed only once", extra.filter((t) => t === "once only").length === 1, extra);
    const logText = fs.readFileSync(path.join(tmp, "logs", "daemon-alex.log"), "utf8");
    check("refusals are logged with a reason", ["bad_sig", "wrong_user", "stale", "bad_agents", "replay"].every((r) => logText.includes(`"reason":"${r}"`)));
    check("typed text never appears in the daemon log", !["plan the release", "echo early", "once only", "rm -rf ~"].some((t) => logText.includes(t)));
    bridge.close();
  }

  // restart: resumes from the last seq stored in SQLite, doesn't re-store old deliveries
  await stopDaemon(d);
  const whileDown = env("sam/orchestrator", "alex/orchestrator", "sent while the daemon was down");
  cloud.deliver("alex", whileDown, false);
  const before = cloud.requests.length;
  d = startDaemon(cloud);
  check("after a restart it connects again", !!(await until(async () => ((await state()) === "connected" ? true : null), 10_000)));
  const firstResume = cloud.requests.slice(before).find((r) => r.path.startsWith("/api/deliveries?since_seq="));
  check("the first resume after a restart starts from the stored seq", !!firstResume && sinceOf(firstResume.path) >= seq1, firstResume?.path);
  check("a delivery made while the daemon was down arrives", !!(await until(async () => (await inbox()).find((i) => i.envelope.id === whileDown.id))));
  check("no old delivery is stored twice after the restart", (await inbox()).filter((i) => i.envelope.id === in1.id).length === 1);

  // revoke: the kick broadcast takes it offline, and login is refused from then on
  cloud.revoke("alex");
  check("a revoke kick takes the daemon offline", !!(await until(async () => ((await state()) === "offline" ? true : null))));
  const afterKick = cloud.requests.length;
  await sleep(1_500);
  check("once revoked it doesn't hammer the API", cloud.requests.length - afterKick <= 1, cloud.requests.slice(afterKick).map((r) => r.path));
  check("its Realtime channels are left", !(await until(() => cloud.rt.joins().some((j) => j.topic === "realtime:deliveries:alex"), 1_000)));
  await stopDaemon(d);

  // the log never contains the access code
  const logText = fs.readFileSync(path.join(tmp, "logs", "daemon-alex.log"), "utf8") + fs.readdirSync(tmp).filter((f) => f.endsWith(".out")).map((f) => fs.readFileSync(path.join(tmp, f), "utf8")).join("");
  check("the daemon log is written", logText.includes("hub.connected"));
  check("the access code is never logged", !logText.includes("code-alex"));
  await cloud.close();

  // ---------------------------------------------------------------- revoked or wrong code at login: no hammering
  {
    const c2 = await startFakeCloud({ codes: { alex: "code-alex" } });
    c2.revoked.add("alex");
    const d2 = startDaemon(c2, { db: path.join(tmp, "revoked.sqlite") });
    check("a revoked code at login (403): offline", !!(await until(async () => ((await state()) === "offline" ? true : null))));
    await sleep(3_000);
    check("...and it never tries again (one login)", c2.requests.filter((r) => r.path === "/api/auth/login").length === 1, c2.requests.map((r) => r.path));
    await stopDaemon(d2);
    const d3 = startDaemon(c2, { code: "wrong", db: path.join(tmp, "wrong2.sqlite") });
    await until(async () => ((await state()) === "offline" ? true : null));
    await sleep(3_000);
    check("a wrong code retries slowly (stays under the API's 10-per-15-min lockout)", c2.requests.filter((r) => r.path === "/api/auth/login").length === 2);
    await stopDaemon(d3);
    await c2.close();
  }
}

const watchdog = setTimeout(() => {
  console.log("FAIL  timed out");
  for (const p of procs) p.kill("SIGKILL");
  process.exit(1);
}, 180_000);
try {
  await main();
} catch (err) {
  failures++;
  console.log(`FAIL  ${(err as Error).stack ?? err}`);
} finally {
  clearTimeout(watchdog);
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
}
console.log(failures ? `\n${failures} failed (logs in ${tmp})` : "\nall passed");
process.exit(failures ? 1 : 0);
