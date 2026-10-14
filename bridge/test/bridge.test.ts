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
import { fileURLToPath } from "node:url";

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

let bridge: ChildProcess | null = null;
function startBridge(direct: boolean) {
  bridge = spawn(process.execPath, ["--import", TSX_LOADER, "src/index.ts"], {
    cwd: BRIDGE_DIR,
    env: {
      ...process.env,
      AGENTLINK_USER: "alex",
      AGENTLINK_DAEMON_PORT: String(ALEX_PORT),
      C4_SESSION: SESSION,
      C4_STATE_DIR: stateDir,
      C4_TMUX_SOCKET: SOCK,
      AGENTLINK_BRIDGE_DIRECT: direct ? "1" : "0",
      AGENTLINK_BRIDGE_DB: join(tmp, "bridge-alex.json"),
      AGENTLINK_BRIDGE_LOG: join(tmp, "bridge-alex.log"),
      AGENTLINK_BRIDGE_SYNC_MS: "500",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
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
  tmux("set", "-p", "-t", panes[3], "@state", "blocked");
  tmux("send-keys", "-t", panes[4], "-l", "* Thinking… (esc to interrupt)");
  p = await until(peers, (m) => m.get("worker-1")?.task === "write the parser" && m.get("worker-3")?.status === "error" && m.get("worker-4")?.status === "working");
  check(p.get("worker-1")?.task === "write the parser", "@task on a pane shows as the session task", p.get("worker-1"));
  check(p.get("worker-3")?.status === "error", "@state blocked -> status error", p.get("worker-3"));
  check(p.get("worker-4")?.status === "working", "'esc to interrupt' on screen -> status working", p.get("worker-4"));
  p = await until(peers, (m) => m.get("orchestrator")?.task === "coordinating 2 workers");
  check(p.get("orchestrator")?.task === "coordinating 2 workers", "orchestrator task counts active workers", p.get("orchestrator"));
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

  console.error("slot removal");
  writeRegistry([0, 1, 2, 3]);
  p = await until(peers, (m) => !m.has("worker-4"));
  check(!p.has("worker-4") && p.has("worker-3"), "a slot that disappears is DELETEd", [...p.keys()]);

  const logText = readFileSync(join(tmp, "bridge-alex.log"), "utf8");
  check(logText.includes('"event":"msg.pasted"') && logText.includes(`"id":"${t1}"`) && logText.includes('"from":"sam/orchestrator"'), "pastes are logged with id/from/to/type");
} catch (err) {
  failures++;
  console.error("bridge test crashed:", err);
} finally {
  await stopBridge();
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
