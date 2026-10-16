// Local terminal input (contracts/input.md) end to end through the REAL daemon:
//   UI-style POST /v1/panes/input on alex's demo daemon -> bridge input stream -> private tmux panes -> result.
// Own demo stack on base 7750 and a PRIVATE tmux server (tmux -L c4test-q1); the live team is never touched.
// Run: npm test (from bridge/), or tsx test/input.test.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = join(HERE, "..");
const ROOT = join(BRIDGE_DIR, "..");
const TSX_LOADER = `file://${join(ROOT, "node_modules/tsx/dist/loader.mjs")}`;
const BASE = 7750;
const ALEX_PORT = BASE + 1;
const UI_ORIGIN = "http://127.0.0.1:7780"; // the daemon's default AGENTLINK_UI_ORIGIN
const SOCK = "c4test-q1";
const SESSION = "c4test-q1-input";
const TOKEN = randomBytes(16).toString("hex");
const AGENTS = ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"];
const tmp = mkdtempSync(join(tmpdir(), "agentlink-input-test-"));
const stateDir = join(tmp, "c4state");
const logPath = join(tmp, "bridge-alex.log");
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
    await sleep(200);
    v = await fn();
  }
  return v;
}

const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" }).trim();
const paneFile = (slot: number) => join(tmp, `pane${slot}.txt`);
const readPane = (slot: number) => (existsSync(paneFile(slot)) ? readFileSync(paneFile(slot), "utf8") : "");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const panes: string[] = [];
const writeRegistry = (slots: number[]) => writeFileSync(join(stateDir, "panes"), slots.map((s) => `${s} ${panes[s]}`).join("\n") + "\n");

function demo(script: "demo-up.sh" | "demo-down.sh", fresh = false) {
  return execFileSync(join(ROOT, "scripts", script), [], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGENTLINK_BASE_PORT: String(BASE), AGENTLINK_TOKEN: TOKEN, ...(fresh ? { DEMO_FRESH: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** What the UI's command bar sends. */
async function postInput(body: unknown, headers: Record<string, string> = { origin: UI_ORIGIN, "x-agentlink-input": "1" }) {
  const res = await fetch(`http://127.0.0.1:${ALEX_PORT}/v1/panes/input`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function resultOf(id: string): Promise<{ state: string; results?: Record<string, string> }> {
  return until(
    () => fetch(`http://127.0.0.1:${ALEX_PORT}/v1/panes/input/${id}`, { headers: { origin: UI_ORIGIN } }).then((r) => r.json()),
    (r) => r.state !== "pending",
  );
}
async function send(agents: string[], text: string, submit?: boolean) {
  const r = await postInput({ agents, text, ...(submit === undefined ? {} : { submit }) });
  if (r.status !== 202) throw new Error(`POST /v1/panes/input -> ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.id as string, ...(await resultOf(r.body.id)) };
}

let bridge: ChildProcess | null = null;

try {
  for (const port of [BASE, ALEX_PORT, BASE + 2]) {
    let inUse = true;
    try {
      execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" });
    } catch {
      inUse = false;
    }
    if (inUse) throw new Error(`port ${port} is busy; run AGENTLINK_BASE_PORT=${BASE} scripts/demo-down.sh first`);
  }

  console.error("setup: demo stack on 7750 + private tmux team");
  demo("demo-up.sh", true);
  mkdirSync(stateDir, { recursive: true });
  panes.push(tmux("new-session", "-d", "-s", SESSION, "-x", "220", "-y", "60", "-P", "-F", "#{pane_id}", `cat >> '${paneFile(0)}'`));
  for (let s = 1; s <= 4; s++) {
    panes.push(tmux("split-window", "-t", `${SESSION}:`, "-P", "-F", "#{pane_id}", `cat >> '${paneFile(s)}'`));
    tmux("select-layout", "-t", `${SESSION}:`, "tiled");
  }
  tmux("set", "-p", "-t", panes[0], "@role", "orchestrator");
  for (const p of panes) {
    tmux("set", "-p", "-t", p, "@state", "working");
    tmux("set", "-p", "-t", p, "@task", "an old task");
  }
  writeRegistry([0, 1, 2, 3, 4]);
  const { AGENTLINK_TOKEN: _t, AGENTLINK_SHARE_SCREENS: _s, ...base } = process.env;
  bridge = spawn(process.execPath, ["--import", TSX_LOADER, "src/index.ts"], {
    cwd: BRIDGE_DIR,
    env: {
      ...base,
      AGENTLINK_USER: "alex",
      AGENTLINK_DAEMON_PORT: String(ALEX_PORT),
      C4_SESSION: SESSION,
      C4_STATE_DIR: stateDir,
      C4_TMUX_SOCKET: SOCK,
      AGENTLINK_BRIDGE_DB: join(tmp, "bridge-alex.json"),
      AGENTLINK_BRIDGE_LOG: logPath,
      AGENTLINK_BRIDGE_SYNC_MS: "500",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const connected = await until(() => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""), (l) => l.includes('"event":"input.stream_connected"'));
  check(connected.includes('"event":"input.stream_connected"'), "bridge connects to the daemon's input stream");
  // Sessions must exist before the boss's panes count; wait for the first status sync.
  await until(() => fetch(`http://127.0.0.1:${ALEX_PORT}/v1/peers`).then((r) => r.json()), (r) => (r.users ?? []).some((u: any) => u.user === "alex" && u.sessions.length === 5));

  console.error("daemon guards (so the test can't be passing by going around them)");
  check((await postInput({ agents: AGENTS, text: "x" }, { origin: "http://127.0.0.1:5173", "x-agentlink-input": "1" })).status === 403, "another localhost origin -> 403");
  check((await postInput({ agents: AGENTS, text: "x" }, { origin: UI_ORIGIN })).status === 403, "missing X-Agentlink-Input -> 403");

  console.error("typing into every pane");
  const TEXT1 = "hello team 7f3a91";
  const r1 = await send(AGENTS, TEXT1);
  check(r1.state === "done" && AGENTS.every((a) => r1.results?.[a] === "sent"), "every pane reports 'sent'", r1);
  const files1 = await until(() => [0, 1, 2, 3, 4].map(readPane), (fs) => fs.every((f) => f.includes(TEXT1)), 5_000);
  check(files1.every((f) => count(f, TEXT1) === 1), "all 5 panes got the text exactly once", files1.map((f) => count(f, TEXT1)));

  console.error("a pane with a yes/no prompt is skipped, not waited on");
  tmux("send-keys", "-t", panes[3], "-l", "Do you want to proceed?");
  await sleep(300);
  const TEXT2 = "second line b2c4d6";
  const t0 = Date.now();
  const r2 = await send(AGENTS, TEXT2);
  check(r2.results?.["worker-3"] === "skipped: prompt_open", "worker-3 -> 'skipped: prompt_open'", r2.results);
  check(AGENTS.filter((a) => a !== "worker-3").every((a) => r2.results?.[a] === "sent"), "the other 4 panes -> 'sent'", r2.results);
  check(Date.now() - t0 < 8_000, `no waiting on the prompt (${Date.now() - t0}ms)`);
  tmux("send-keys", "-t", panes[3], "C-u");
  await sleep(500);
  check(!readPane(3).includes(TEXT2) && !tmux("capture-pane", "-p", "-t", panes[3]).includes(TEXT2), "nothing was typed into the prompt pane");

  console.error("submit: false types without Enter");
  const TEXT3 = "draft only 9e8d7c";
  const r3 = await send(["worker-1"], TEXT3, false);
  await sleep(500);
  check(r3.results?.["worker-1"] === "sent" && tmux("capture-pane", "-p", "-t", panes[1]).includes(TEXT3) && !readPane(1).includes(TEXT3), "the text is on screen but not submitted", r3);
  tmux("send-keys", "-t", panes[1], "C-u");

  console.error("Reset chats (/clear)");
  const r4 = await send(AGENTS, "/clear");
  check(AGENTS.every((a) => r4.results?.[a] === "sent"), "/clear sent to every pane", r4.results);
  const opts = panes.map((p) => [tmux("show", "-pqv", "-t", p, "@state"), tmux("show", "-pqv", "-t", p, "@task")]);
  check(opts.every(([st, tk]) => st === "idle" && tk === ""), "each pane's @state is idle and @task is ''", opts);
  const files4 = await until(() => [0, 1, 2, 3, 4].map(readPane), (fs) => fs.every((f) => f.includes("/clear")), 5_000);
  check(files4.every((f) => count(f, "/clear") === 1), "each pane got /clear once");
  const peers = await until(
    () => fetch(`http://127.0.0.1:${ALEX_PORT}/v1/peers`).then((r) => r.json()),
    (r) => (r.users ?? []).find((u: any) => u.user === "alex")?.sessions.every((s: any) => s.task === ""),
    5_000,
  );
  check((peers.users ?? []).find((u: any) => u.user === "alex")?.sessions.every((s: any) => s.task === ""), "the hub stops showing the old tasks", peers);
  tmux("set", "-p", "-t", panes[2], "@state", "working");
  const r5 = await send(["worker-2"], "/clear please");
  check(r5.results?.["worker-2"] === "sent" && tmux("show", "-pqv", "-t", panes[2], "@state") === "working", "only exactly '/clear' resets the options");

  console.error("a slot with no pane");
  writeRegistry([0, 1, 2, 3]);
  await sleep(1_000);
  const r6 = await send(["worker-4", "worker-1"], "after removal 5a5a5a");
  check(r6.results?.["worker-4"] === "skipped: no_pane" && r6.results?.["worker-1"] === "sent", "a missing slot -> 'skipped: no_pane'", r6.results);

  console.error("logging");
  const logText = readFileSync(logPath, "utf8");
  check(logText.includes(`"event":"input.typed","id":"${r1.id}"`), "input.typed is logged with id/agent/result");
  check(logText.includes('"result":"skipped: prompt_open"'), "the skip is logged");
  check(![TEXT1, TEXT2, TEXT3, "after removal 5a5a5a", "/clear please"].some((t) => logText.includes(t)), "the typed text never appears in the bridge log");
} catch (err) {
  failures++;
  console.error("input test crashed:", err);
} finally {
  if (bridge && bridge.exitCode === null) {
    bridge.kill("SIGTERM");
    await until(() => bridge!.exitCode, (c) => c !== null, 5_000);
    if (bridge.exitCode === null) bridge.kill("SIGKILL");
  }
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
