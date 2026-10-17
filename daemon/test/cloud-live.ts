// Live end-to-end test of the daemon's cloud link against the REAL cloud API (cloud/, `next dev`) and a
// local Supabase (`supabase start`). Opt-in: does nothing unless CLOUD_LIVE_URL is set.
//
//   CLOUD_LIVE_URL=http://127.0.0.1:3010 npx tsx test/cloud-live.ts      (from daemon/)
//
// It reads AGENTLINK_OWNER and AGENTLINK_MASTER_CODE from cloud/.env.local (never printed), invites a test
// person (q2e2e) with bin/agentlink-cloud, runs two daemons (owner on 7771, q2e2e on 7772) in a temp dir,
// and revokes q2e2e at the end. It adds rows to the database; it never deletes any.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import type { DaemonHealth, InboxItem } from "../../contracts/index.ts";

const BASE = process.env.CLOUD_LIVE_URL;
if (!BASE) {
  console.log("skip: set CLOUD_LIVE_URL (e.g. http://127.0.0.1:3010) to run against a real cloud API");
  process.exit(0);
}
const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const daemonDir = path.join(ROOT, "daemon");
const TSX_LOADER = pathToFileURL(path.join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cloud-live-"));
const envLocal = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "cloud/.env.local"), "utf8").split("\n").map((l) => /^([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m![1], m![2].replace(/^"|"$/g, "")]),
);
const OWNER = envLocal.AGENTLINK_OWNER;
const MASTER = envLocal.AGENTLINK_MASTER_CODE;
const GUEST = "q2e2e";
const PORT = { owner: 7771, guest: 7772 };
const procs: ChildProcess[] = [];
const secrets: string[] = [MASTER];
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  let d = detail === undefined ? "" : JSON.stringify(detail).slice(0, 500);
  for (const s of secrets) if (s) d = d.split(s).join("<code>");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && d ? `  -> ${d}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms = 15_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await sleep(100);
  }
  return undefined;
}
const dapi = async (port: number, method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const state = async (port: number) => ((await dapi(port, "GET", "/v1/health").catch(() => null))?.body as DaemonHealth | null)?.hub.state;
const inbox = async (port: number) => ((await dapi(port, "GET", "/v1/inbox?limit=500")).body as { messages: InboxItem[] }).messages;
const cloud = async (method: string, p: string, session: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${session}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const login = async (code: string) => (await (await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json()) as { session: string; user: string; realtime: { url: string; anon_key: string; jwt: string } };

function startDaemon(user: string, code: string, port: number) {
  const dir = path.join(tmp, user);
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: dir,
    env: { ...process.env, AGENTLINK_USER: user, AGENTLINK_TOKEN: code, AGENTLINK_HUB_URL: BASE!, AGENTLINK_HUB_MODE: "cloud", AGENTLINK_DAEMON_PORT: String(port), AGENTLINK_DAEMON_DB: path.join(dir, "d.sqlite") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(path.join(dir, "out.log"));
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}
function fakeBridge(port: number) {
  const got: Array<{ id: string; agents: string[]; text: string }> = [];
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
        void dapi(port, "POST", `/v1/panes/input/${f.id}/result`, { results: Object.fromEntries(f.agents.map((a: string) => [a, "sent"])) });
      }
    });
  });
  req.on("error", () => {});
  return { got, close: () => req.destroy() };
}

try {
  check("cloud API is up", (await fetch(BASE + "/api/health").then((r) => r.ok).catch(() => false)));
  // invite the test person (a re-run re-invites: new code, old one dies)
  const inv = await run(path.join(ROOT, "bin/agentlink-cloud"), ["invite", GUEST], { env: { ...process.env, AGENTLINK_CLOUD_URL: BASE, AGENTLINK_MASTER_CODE: MASTER } });
  const GUEST_CODE = /\b(alc_[A-Za-z0-9_-]{20,})\b/.exec(inv.stdout)?.[1] ?? "";
  secrets.push(GUEST_CODE);
  check("bin/agentlink-cloud invite gives the test person a code", !!GUEST_CODE);

  startDaemon(OWNER, MASTER, PORT.owner);
  startDaemon(GUEST, GUEST_CODE, PORT.guest);
  check("owner daemon connects (master code)", !!(await until(async () => (await state(PORT.owner)) === "connected")), await state(PORT.owner));
  check("guest daemon connects (invited code)", !!(await until(async () => (await state(PORT.guest)) === "connected")), await state(PORT.guest));
  await dapi(PORT.owner, "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "working", task: "live e2e" });
  await dapi(PORT.guest, "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "idle", task: "" });
  await dapi(PORT.guest, "PUT", "/v1/sessions/worker-1", { kind: "worker", status: "idle", task: "" });

  // messages both ways, received over real postgres_changes (RLS + the username filter)
  const m1 = (await dapi(PORT.guest, "POST", "/v1/send", { from_agent: "orchestrator", to: `${OWNER}/orchestrator`, type: "task", body: "live: hello boss" })).body as { id: string };
  const got1 = await until(async () => (await inbox(PORT.owner)).find((i) => i.envelope.id === m1.id));
  check("guest -> owner: delivered over Realtime and stored as remote", !!got1 && got1.remote === true, got1);
  const m2 = (await dapi(PORT.owner, "POST", "/v1/send", { from_agent: "orchestrator", to: `${GUEST}/orchestrator`, type: "result", body: "live: got it", reply_to: m1.id })).body as { id: string };
  check("owner -> guest: delivered", !!(await until(async () => (await inbox(PORT.guest)).find((i) => i.envelope.id === m2.id))));
  const peers = await dapi(PORT.guest, "GET", "/v1/peers");
  const users = (peers.body as { users: Array<{ user: string; sessions: Array<{ agent: string }> }> }).users ?? [];
  check("GET /v1/peers (proxied) lists both teams' sessions", users.some((u) => u.user === OWNER && u.sessions.some((s) => s.agent === "orchestrator")) && users.some((u) => u.user === GUEST && u.sessions.some((s) => s.agent === "worker-1")), users.map((u) => u.user));

  // typing into your own panes from the website: guest's API session -> guest's daemon -> its bridge
  const bridge = fakeBridge(PORT.guest);
  await sleep(500);
  const gs = await login(GUEST_CODE);
  const inp = await fetch(BASE + "/api/panes/input", { method: "POST", headers: { authorization: `Bearer ${gs.session}`, "content-type": "application/json" }, body: JSON.stringify({ agents: ["worker-1"], text: "echo live-input", submit: true }) });
  const inpBody = (await inp.json()) as { id?: string; error?: string };
  check("POST /api/panes/input accepted (202)", inp.status === 202 && !!inpBody.id, { status: inp.status, body: inpBody });
  const typed = await until(() => bridge.got.find((g) => g.text === "echo live-input"));
  check("the input reaches the guest's bridge (signed frame passed the gate)", !!typed && typed.agents.join() === "worker-1", typed);
  const res = await until(async () => {
    const r = await cloud("GET", `/api/panes/input/${inpBody.id}`, gs.session);
    return (r.body as { state?: string })?.state === "done" ? r.body : null;
  });
  check("the bridge's result is visible on the website (GET /api/panes/input/:id)", (res as { results?: Record<string, string> })?.results?.["worker-1"] === "sent", res);
  bridge.close();

  // a screen reaches a real watcher (the owner's browser, as a supabase-js client tracking presence)
  const os_ = await login(MASTER);
  const sb = createClient(os_.realtime.url, os_.realtime.anon_key, { accessToken: async () => os_.realtime.jwt, auth: { persistSession: false, autoRefreshToken: false } });
  await sb.realtime.setAuth(os_.realtime.jwt);
  const seen: Array<{ address: string; screen: { text: string } }> = [];
  const ch = sb.channel("screens", { config: { private: true, presence: { key: `${OWNER}:live` } } }).on("broadcast", { event: "screen" }, (m) => seen.push(m.payload as never));
  await new Promise<void>((resolve, reject) => ch.subscribe((s, e) => (s === "SUBSCRIBED" ? resolve() : s !== "CLOSED" && reject(new Error(`${s} ${e?.message ?? ""}`)))));
  await ch.track({ user: OWNER, watching: [`${GUEST}/worker-1`] });
  await sleep(1_500);
  await dapi(PORT.guest, "PUT", "/v1/screens/worker-1", { text: "live screen text", cols: 80, rows: 24 });
  const scr = await until(() => seen.find((s) => s.address === `${GUEST}/worker-1`));
  check("a watched pane's screen reaches the watcher over Realtime", scr?.screen.text === "live screen text", seen.slice(0, 3));
  await sb.removeAllChannels();

  // revoke: the guest daemon is kicked and stays offline
  await run(path.join(ROOT, "bin/agentlink-cloud"), ["revoke", GUEST], { env: { ...process.env, AGENTLINK_CLOUD_URL: BASE, AGENTLINK_MASTER_CODE: MASTER } });
  check("revoking the guest takes its daemon offline", !!(await until(async () => (await state(PORT.guest)) === "offline")), await state(PORT.guest));
  check("the owner daemon stays connected", (await state(PORT.owner)) === "connected");
  const logs = [OWNER, GUEST].map((u) => fs.readFileSync(path.join(tmp, u, "logs", `daemon-${u}.log`), "utf8") + fs.readFileSync(path.join(tmp, u, "out.log"), "utf8")).join("");
  check("no access code and no typed text in the daemon logs", !logs.includes(MASTER) && !logs.includes(GUEST_CODE) && !logs.includes("echo live-input"));
} catch (err) {
  failures++;
  let m = String((err as Error).stack ?? err);
  for (const s of secrets) if (s) m = m.split(s).join("<code>");
  console.log(`FAIL  ${m}`);
} finally {
  for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
  await sleep(500);
  for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
}
console.log(failures ? `\n${failures} failed (files in ${tmp})` : "\nall passed");
process.exit(failures ? 1 : 0);
