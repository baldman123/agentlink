// Bridge test against a throwaway c4 team and this package's own demo stack.
//   - demo stack on base 7750 (hub 7750, alex daemon 7751, sam daemon 7752), started fresh and torn down
//   - a PRIVATE tmux server (tmux -L c4test-q1), session c4test-q1, 5 panes running `cat >> paneN.txt`
//   - a fake c4 registry in a temp dir (C4_STATE_DIR), so ~/.claude4 is never touched
// The real claude4 session lives on the default tmux server; this test never talks to it.
//
// Run: npm test (from bridge/)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { ScreenUpdate, ServerFrame } from "../../contracts/index.ts";
import { handshake } from "../../hub/test/handshake.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = join(HERE, "..");
const ROOT = join(BRIDGE_DIR, "..");
const TSX_LOADER = `file://${join(ROOT, "node_modules/tsx/dist/loader.mjs")}`;
const BASE = 7750;
const ALEX_PORT = BASE + 1;
const SAM_PORT = BASE + 2;
const SOCK = "c4test-q1";
const SESSION = "c4test-q1";
const TOKEN = randomBytes(16).toString("hex");
const tmp = mkdtempSync(join(tmpdir(), "agentlink-bridge-test-"));
const stateDir = join(tmp, "c4state");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passes = 0;
let failures = 0;
function check(cond: unknown, name: string, detail?: unknown) {
  if (cond) {
    passes++;
    console.error(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
  }
}

async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(250);
    v = await fn();
  }
  return v;
}

const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" }).trim();
const paneFile = (slot: number) => join(tmp, `pane${slot}.txt`);
const readPane = (slot: number) => (existsSync(paneFile(slot)) ? readFileSync(paneFile(slot), "utf8") : "");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** The footer is the last pasted line; cat only writes it after the Enter, so wait for it, not the header. */
const footer = (id: string) => `agentlink reply ${id.slice(0, 8)} `;
const pasted = (slot: number, id: string) => until(() => readPane(slot), (s) => s.includes(footer(id)));

function demo(script: "demo-up.sh" | "demo-down.sh", fresh = false) {
  return execFileSync(join(ROOT, "scripts", script), [], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTLINK_BASE_PORT: String(BASE), AGENTLINK_TOKEN: TOKEN, ...(fresh ? { DEMO_FRESH: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function peers(): Promise<Map<string, { kind: string; status: string; task: string }>> {
  const r = await fetch(`http://127.0.0.1:${ALEX_PORT}/v1/peers`).then((x) => x.json());
  const out = new Map();
  for (const u of r.users ?? []) if (u.user === "alex") for (const s of u.sessions) out.set(s.agent, s);
  return out;
}

/** sam's orchestrator CLI sends a message from the other daemon. */
function samSends(to: string, type: string, body: string): string {
  const out = execFileSync(
    process.execPath,
    ["--import", TSX_LOADER, join(ROOT, "orchestrator/src/cli.ts"), "send", to, type, body, "--port", String(SAM_PORT), "--from", "orchestrator", "--json"],
    { encoding: "utf8", env: { ...process.env, AGENTLINK_ORCH_LOG_DIR: join(tmp, "orch-logs"), AGENTLINK_ORCH_DATA_DIR: join(tmp, "orch-data") } },
  );
  return JSON.parse(out).id as string;
}

/** The person at alex's UI sends to their own team (from_agent "human", via alex's daemon). */
function alexUiSends(to: string, body: string): string {
  const out = execFileSync(
    "curl",
    ["-fsS", "-X", "POST", "-H", "content-type: application/json", "--data", JSON.stringify({ from_agent: "human", to, type: "chat", body }), `http://127.0.0.1:${ALEX_PORT}/v1/send`],
    { encoding: "utf8" },
  );
  return JSON.parse(out).id as string;
}

function spawnBridge(env: Record<string, string>): ChildProcess {
  const { AGENTLINK_TOKEN: _drop, AGENTLINK_SHARE_SCREENS: _drop2, ...base } = process.env;
  const child = spawn(process.execPath, ["--import", TSX_LOADER, "src/index.ts"], {
    cwd: BRIDGE_DIR,
    env: {
      ...base,
      AGENTLINK_USER: "alex",
      AGENTLINK_DAEMON_PORT: String(ALEX_PORT),
      C4_SESSION: SESSION,
      C4_STATE_DIR: stateDir,
      C4_TMUX_SOCKET: SOCK,
      AGENTLINK_BRIDGE_SYNC_MS: "500",
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  return child;
}
const children: ChildProcess[] = [];

let hubSocket: WebSocket | null = null;
/** A REST session for the demo hub: open a v2 ui socket (hub/test/handshake.ts) and keep it open. */
async function hubSession(): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${BASE}/ws`);
  hubSocket = ws;
  const queue: ServerFrame[] = [];
  let closed = false;
  ws.on("message", (d) => queue.push(JSON.parse(d.toString())));
  ws.on("close", () => (closed = true));
  await new Promise<void>((r, j) => (ws.once("open", () => r()), ws.once("error", j)));
  const next = async () => {
    for (let i = 0; i < 200 && !queue.length && !closed; i++) await sleep(10);
    return queue.shift() ?? null;
  };
  const r = await handshake(ws, next, { token: TOKEN, user: "alex", role: "ui" });
  if (!r.ok) throw new Error(`v2 handshake with the demo hub failed: ${r.reason}`);
  return r.session;
}

function closeHubSocket() {
  hubSocket?.close();
  hubSocket = null;
}

let bridge: ChildProcess | null = null;
function startBridge(direct: boolean) {
  bridge = spawnBridge({
    AGENTLINK_BRIDGE_DIRECT: direct ? "1" : "0",
    AGENTLINK_BRIDGE_DB: join(tmp, "bridge-alex.json"),
    AGENTLINK_BRIDGE_LOG: join(tmp, "bridge-alex.log"),
  });
}

/**
 * Stand-in for the daemon's /v1/screens endpoint (quarter 2 is adding the real one). Records screen PUTs and
 * DELETEs; answers the other endpoints the bridge calls with empty, valid responses.
 */
async function startStubDaemon() {
  const puts: ScreenUpdate[] = [];
  const deletes: string[] = [];
  const streams = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url ?? "/", "http://stub");
    let m: RegExpMatchArray | null;
    if ((m = url.pathname.match(/^\/v1\/screens\/([^/]+)$/))) {
      if (req.method === "PUT") puts.push(JSON.parse(body));
      if (req.method === "DELETE") deletes.push(decodeURIComponent(m[1]));
      return void res.writeHead(204).end();
    }
    if (url.pathname.startsWith("/v1/sessions/")) {
      if (req.method === "DELETE") return void res.writeHead(204).end();
      return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
    if (url.pathname === "/v1/inbox/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      streams.add(res);
      return;
    }
    if (url.pathname === "/v1/inbox") return void res.writeHead(200, { "content-type": "application/json" }).end('{"messages":[]}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    puts,
    deletes,
    latest: (agent: string) => [...puts].reverse().find((u) => u.agent === agent),
    close: () =>
      new Promise<void>((r) => {
        for (const s of streams) s.end();
        server.close(() => r());
      }),
  };
}
async function stopBridge() {
  if (!bridge || bridge.exitCode !== null) return;
  const b = bridge;
  b.kill("SIGTERM");
  await until(() => b.exitCode, (c) => c !== null, 5_000);
  if (b.exitCode === null) b.kill("SIGKILL");
}

const panes: string[] = [];
function writeRegistry(slots: number[]) {
  writeFileSync(join(stateDir, "panes"), slots.map((s) => `${s} ${panes[s]}`).join("\n") + "\n");
}

try {
  for (const port of [BASE, ALEX_PORT, SAM_PORT]) {
    let inUse = true;
    try {
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    } catch {
      inUse = false;
    }
    if (inUse) throw new Error(`port ${port} is busy; stop whatever runs there (AGENTLINK_BASE_PORT=${BASE} scripts/demo-down.sh) first`);
  }

  console.error("setup: demo stack on 7750 + fake c4 team on tmux -L c4test-q1");
  demo("demo-up.sh", true);
  execFileSync("mkdir", ["-p", stateDir]);
  panes.push(tmux("new-session", "-d", "-s", SESSION, "-x", "220", "-y", "60", "-P", "-F", "#{pane_id}", `cat >> '${paneFile(0)}'`));
  for (let s = 1; s <= 4; s++) {
    panes.push(tmux("split-window", "-t", `${SESSION}:`, "-P", "-F", "#{pane_id}", `cat >> '${paneFile(s)}'`));
    tmux("select-layout", "-t", `${SESSION}:`, "tiled");
  }
  tmux("set", "-p", "-t", panes[0], "@role", "orchestrator");
  writeRegistry([0, 1, 2, 3, 4]);
  startBridge(false);

  console.error("status sync");
  let p = await until(peers, (m) => ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"].every((a) => m.has(a)));
  check(p.get("orchestrator")?.kind === "orchestrator" && p.get("worker-2")?.kind === "worker" && p.size === 5, "5 slots appear in /v1/peers with the right kinds", [...p.entries()]);
  tmux("set", "-p", "-t", panes[1], "@task", "write the parser");
  tmux("set", "-p", "-t", panes[1], "@state", "working");
  tmux("set", "-p", "-t", panes[3], "@state", "blocked");
  tmux("send-keys", "-t", panes[4], "-l", "* Thinking… (esc to interrupt)");
  p = await until(peers, (m) => m.get("worker-1")?.task === "write the parser" && m.get("worker-3")?.status === "error" && m.get("worker-4")?.status === "working");
  check(p.get("worker-1")?.task === "write the parser", "@task on a pane shows as the session task", p.get("worker-1"));
  check(p.get("worker-3")?.status === "error", "@state blocked -> status error", p.get("worker-3"));
  check(p.get("worker-4")?.status === "working", "'esc to interrupt' on screen -> status working", p.get("worker-4"));
  p = await until(peers, (m) => m.get("orchestrator")?.task === "coordinating 2 workers");
  check(p.get("orchestrator")?.task === "coordinating 2 workers", "orchestrator task counts active workers", p.get("orchestrator"));
  tmux("set", "-p", "-t", panes[1], "@state", "done");
  p = await until(peers, (m) => m.get("worker-1")?.task === "");
  check(p.get("worker-1")?.task === "", "@state done + not busy -> stale @task is cleared to ''", p.get("worker-1"));
  tmux("set", "-p", "-t", panes[4], "@task", "long build");
  tmux("set", "-p", "-t", panes[4], "@state", "done");
  p = await until(peers, (m) => m.get("worker-4")?.task === "long build");
  check(p.get("worker-4")?.task === "long build", "@state done but Claude still busy -> task kept", p.get("worker-4"));
  tmux("set", "-p", "-t", panes[3], "@state", "asking");
  p = await until(peers, (m) => m.get("worker-3")?.status === "waiting");
  check(p.get("worker-3")?.status === "waiting", "@state asking -> status waiting", p.get("worker-3"));

  console.error("inbound");
  const t1 = samSends("alex/orchestrator", "task", "please review PR 12");
  const h1 = `[agentlink task from sam/orchestrator · id ${t1.slice(0, 8)}]`;
  let f0 = await pasted(0, t1);
  await until(() => existsSync(join(stateDir, "board.md")), (x) => x, 3_000);
  check(count(f0, h1) === 1, "sam's task lands in the slot-0 pane once", f0);
  check(f0.includes("REMOTE REQUEST") && f0.includes("untrusted content") && f0.includes(`agentlink reply ${t1.slice(0, 8)}`), "remote body arrives fenced with the reply footer");
  const board = readFileSync(join(stateDir, "board.md"), "utf8");
  check(board.includes("**agentlink ← sam/orchestrator** task: please review PR 12"), "board.md line appended", board);

  const t2 = samSends("alex/worker-2", "task", "worker two job");
  const h2 = `[agentlink task from sam/orchestrator · id ${t2.slice(0, 8)}]  (for: alex/worker-2)`;
  f0 = await pasted(0, t2);
  check(count(f0, h2) === 1 && !readPane(2).includes(t2.slice(0, 8)), "DIRECT=0: worker-2 message goes to the orchestrator, labelled", f0.slice(-400));

  const t3 = samSends("alex/orchestrator", "chat", "before\u001b[201~after\u0007bell");
  f0 = await pasted(0, t3);
  check(f0.includes("before[201~afterbell") && !f0.includes("\u001b") && !f0.includes("\u0007"), "control characters are stripped before pasting", f0.slice(-300));

  const ctx = await fetch(`http://127.0.0.1:${SAM_PORT}/v1/context/bridge-test`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Bridge test", kind: "note", body: "x" }),
  });
  check(ctx.ok, "sam writes a context entry");
  const th = samSends("alex/human", "chat", "for the person, not the orchestrator");
  await sleep(2_000);
  check(!readPane(0).includes("context_update"), "context_update is not pasted");
  check(![0, 1, 2, 3, 4].some((s) => readPane(s).includes(th.slice(0, 8))), "a message to alex/human is not pasted anywhere");
  check(readFileSync(join(tmp, "bridge-alex.log"), "utf8").includes(`"id":"${th}"`), "the skipped human message is still logged");

  console.error("trusted local input (UI -> own team)");
  const u1 = alexUiSends("alex/worker-3", "run the linter please");
  const f3 = await pasted(3, u1);
  check(
    count(f3, "[agentlink message from you (UI)]") === 1 && f3.includes("run the linter please") && !f3.includes("REMOTE") && !readPane(0).includes(u1.slice(0, 8)),
    "alex/human -> alex/worker-3 goes straight to slot 3 (no DIRECT), labelled, no REMOTE banner",
    f3,
  );
  const u2 = alexUiSends("alex/orchestrator", "status update please");
  f0 = await pasted(0, u2);
  check(f0.includes("[agentlink message from you (UI)]\nstatus update please"), "alex/human -> alex/orchestrator goes to the boss pane, labelled", f0.slice(-300));
  const s1 = samSends("alex/worker-3", "chat", "sam asks worker three");
  f0 = await pasted(0, s1);
  check(f0.includes(`(for: alex/worker-3)`) && !readPane(3).includes(s1.slice(0, 8)), "another user's message to a worker keeps the old rules (orchestrator, DIRECT=0)");

  console.error("prompt wait");
  tmux("send-keys", "-t", panes[0], "-l", "Do you want to proceed?");
  const t4 = samSends("alex/orchestrator", "chat", "held until the prompt clears");
  await sleep(2_500);
  check(!readPane(0).includes(t4.slice(0, 8)), "nothing is pasted while a yes/no prompt is on screen");
  tmux("send-keys", "-t", panes[0], "C-u");
  f0 = await pasted(0, t4);
  check(count(f0, `id ${t4.slice(0, 8)}]`) === 1, "pasted once the prompt is gone");

  console.error("restart + DIRECT=1");
  await stopBridge();
  p = await until(peers, (m) => m.get("orchestrator")?.status === "offline", 5_000);
  check(p.get("orchestrator")?.status === "offline", "bridge shutdown marks sessions offline", p.get("orchestrator"));
  startBridge(true);
  p = await until(peers, (m) => m.get("orchestrator")?.status === "idle");
  check(p.get("orchestrator")?.status === "idle", "restarted bridge re-registers sessions", p.get("orchestrator"));
  await sleep(3_000);
  f0 = readPane(0);
  check(count(f0, h1) === 1 && count(f0, h2) === 1 && count(f0, `id ${t4.slice(0, 8)}]`) === 1, "restart does not re-paste anything", f0.slice(-600));
  const t5 = samSends("alex/worker-2", "task", "direct to two");
  const f2 = await pasted(2, t5);
  check(count(f2, `id ${t5.slice(0, 8)}]`) === 1 && !readPane(0).includes(t5.slice(0, 8)), "DIRECT=1: worker-2 message goes to slot 2", f2);

  console.error("screens (opt-in; second bridge against a stub daemon)");
  check(!readFileSync(join(tmp, "bridge-alex.log"), "utf8").includes('"event":"screen.'), "without AGENTLINK_SHARE_SCREENS no screen is sent");
  const stub = await startStubDaemon();
  const shareBridge = spawnBridge({
    AGENTLINK_DAEMON_PORT: String(stub.port),
    AGENTLINK_SHARE_SCREENS: "1",
    AGENTLINK_SCREEN_MS: "200",
    AGENTLINK_TOKEN: TOKEN,
    AGENTLINK_BRIDGE_DB: join(tmp, "bridge-share.json"),
    AGENTLINK_BRIDGE_LOG: join(tmp, "bridge-share.log"),
  });
  await until(() => new Set(stub.puts.map((u) => u.agent)).size, (n) => n === 5);
  const agents = new Set(stub.puts.map((u) => u.agent));
  check(["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"].every((a) => agents.has(a)), "PUT /v1/screens/:agent for all 5 slots", [...agents]);
  const first = stub.latest("worker-2")!;
  check(first.cols > 0 && first.rows > 0 && typeof first.text === "string" && typeof first.busy === "boolean", "ScreenUpdate has text, cols, rows, busy", first);
  check(stub.latest("worker-4")?.busy === true && stub.latest("worker-2")?.busy === false, "busy follows 'esc to interrupt' on screen");
  check(stub.puts.every((u) => !/\u001b(?!\[[0-9;]*m)/.test(u.text)), "screen text carries no escape codes except SGR");

  tmux("send-keys", "-t", panes[2], "-l", `export AGENTLINK_TOKEN=${TOKEN} key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV ghp_16C7e42F292c6912E7710c838347Ae178B4a`);
  const red = await until(() => stub.latest("worker-2")?.text ?? "", (t) => t.includes("export AGENTLINK_TOKEN="));
  check(red.includes("[redacted]") && !red.includes(TOKEN) && !red.includes("sk-ant-api03") && !red.includes("ghp_16C7"), "secrets on screen are redacted before sending", red.slice(-300));

  tmux("respawn-pane", "-k", "-t", panes[3], `printf '\\033]0;title\\007\\033[31mRED\\033[0m plain\\n'; exec cat >> '${paneFile(3)}'`);
  const col = await until(() => stub.latest("worker-3")?.text ?? "", (t) => t.includes("plain"));
  check(col.includes("\u001b[31mRED") && !col.includes("title"), "SGR colours are kept, other sequences dropped", JSON.stringify(col.slice(-120)));

  await sleep(1_500);
  const quietFrom = stub.puts.length;
  await sleep(3_000);
  const quiet = stub.puts.slice(quietFrom).filter((u) => u.agent === "worker-1").length;
  check(quiet === 0, "an unchanged pane is not resent", quiet);

  const burstFrom = stub.puts.length;
  const burstStart = Date.now();
  for (let i = 0; i < 20; i++) {
    tmux("send-keys", "-t", panes[1], "-l", `${i % 10}`);
    await sleep(100);
  }
  const burstMs = Date.now() - burstStart;
  const burst = stub.puts.slice(burstFrom).filter((u) => u.agent === "worker-1").length;
  check(burst >= 2 && burst <= Math.ceil(burstMs / 500) + 1, `at most 2 updates/s per pane while it changes (${burst} in ${burstMs}ms)`, burst);

  console.error("slot removal");
  writeRegistry([0, 1, 2, 3]);
  p = await until(peers, (m) => !m.has("worker-4"));
  check(!p.has("worker-4") && p.has("worker-3"), "a slot that disappears is DELETEd", [...p.keys()]);
  await until(() => stub.deletes, (d) => d.includes("worker-4"), 5_000);
  check(stub.deletes.includes("worker-4"), "its screen is DELETEd too (DELETE /v1/screens/worker-4)", stub.deletes);
  shareBridge.kill("SIGTERM");
  await until(() => shareBridge.exitCode, (c) => c !== null, 5_000);
  check(["orchestrator", "worker-1", "worker-2", "worker-3"].every((a) => stub.deletes.includes(a)), "bridge shutdown DELETEs its screens", stub.deletes);
  const shareLog = readFileSync(join(tmp, "bridge-share.log"), "utf8");
  check(!shareLog.includes(TOKEN), "the token never appears in the bridge log");
  await stub.close();

  console.error("screens through the real daemon and hub");
  await stopBridge();
  bridge = spawnBridge({
    AGENTLINK_BRIDGE_DIRECT: "1",
    AGENTLINK_BRIDGE_DB: join(tmp, "bridge-alex.json"),
    AGENTLINK_BRIDGE_LOG: join(tmp, "bridge-alex.log"),
    AGENTLINK_SHARE_SCREENS: "1",
    AGENTLINK_TOKEN: TOKEN,
  });
  const viaDaemon = await until(
    () => fetch(`http://127.0.0.1:${ALEX_PORT}/v1/screens/worker-2`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    (s) => !!s && typeof s.text === "string",
  );
  check(viaDaemon && viaDaemon.text.includes("[redacted]") && !viaDaemon.text.includes(TOKEN), "daemon GET /v1/screens/worker-2 has the redacted screen", viaDaemon && { ...viaDaemon, text: viaDaemon.text.slice(-120) });
  // Protocol v2: hub REST takes a session from a live socket's welcome, never the shared token.
  const restSession = await hubSession();
  const hubScreens = await until(
    () => fetch(`http://127.0.0.1:${BASE}/api/screens`, { headers: { authorization: `Bearer ${restSession}` } }).then((r) => r.json()).catch(() => ({ screens: [] })),
    (r) => (r.screens ?? []).some((s: any) => s.address === "alex/worker-2"),
  );
  check((hubScreens.screens ?? []).some((s: any) => s.address === "alex/worker-2" && s.cols > 0 && !("text" in s)), "hub GET /api/screens lists alex/worker-2 (no text)", hubScreens);

  const logText = readFileSync(join(tmp, "bridge-alex.log"), "utf8");
  check(logText.includes('"event":"msg.pasted"') && logText.includes(`"id":"${t1}"`) && logText.includes('"from":"sam/orchestrator"'), "pastes are logged with id/from/to/type");
} catch (err) {
  failures++;
  console.error("bridge test crashed:", err);
} finally {
  closeHubSocket();
  await stopBridge();
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  try {
    tmux("kill-session", "-t", SESSION);
  } catch {}
  try {
    demo("demo-down.sh");
  } catch (err) {
    console.error("demo-down failed:", (err as Error).message);
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.error(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
