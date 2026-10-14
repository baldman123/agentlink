// Two-team end-to-end test: two users (alex, sam) on one hub, each with a fake claude4 team
// (a throwaway tmux session of 5 `cat` panes plus a registry in ~/.claude4/c4e2e-<user>/) and a
// bridge, all started through scripts/team-up.sh. Never touches the real claude4 session.
//
//   npx tsx scripts/two-team-e2e.ts        (AGENTLINK_BASE_PORT, default 7730: hub, +1 alex, +2 sam)
//
// Prints PASS/FAIL per check, always tears down (team-down.sh for both users, kills the two tmux
// sessions, removes the fake registries) and exits non-zero on any failure.
// Step 6 covers live screens (contracts/screens.md): alex shares, sam doesn't, read through a
// ui-role hub socket the way the web UI reads them.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { InboxItem, ScreenInfo, ServerFrame, UserPresence } from "../contracts/index.ts";
import { PROTOCOL_VERSION } from "../contracts/index.ts";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = Number(process.env.AGENTLINK_BASE_PORT ?? 7730);
const HUB = BASE;
const PORT = { alex: BASE + 1, sam: BASE + 2 } as const;
type User = keyof typeof PORT;
const USERS: User[] = ["alex", "sam"];
const TOKEN = randomBytes(16).toString("hex");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-two-team-"));
const dataDir = (u: User) => path.join(TMP, u);
const session = (u: User) => `c4e2e-${u}`;
// The fake teams live on their own tmux server and their registries in TMP, so nothing here can
// reach the real claude4 server or ~/.claude4. The bridge honours C4_TMUX_SOCKET and C4_STATE_DIR.
const SOCKET = "c4e2e";
const c4Dir = (u: User) => path.join(TMP, "claude4", session(u));
const panes: Record<User, Record<number, string>> = { alex: {}, sam: {} }; // slot -> tmux pane id

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 700)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message ?? last})` : ""}`);
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}: ${(err as Error).message}`, false);
  }
}

// ---------------------------------------------------------------- helpers

async function tmux(...args: string[]): Promise<string> {
  return (await run("tmux", ["-L", SOCKET, ...args])).stdout;
}
const screen = (u: User, slot: number) => tmux("capture-pane", "-p", "-J", "-S", "-3000", "-t", panes[u][slot]);
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

async function api(u: User, method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT[u]}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const sessionsAtHub = async () => ((await api("alex", "GET", "/v1/peers")).body as { users: UserPresence[] }).users;
async function hubSession(address: string) {
  for (const u of await sessionsAtHub()) for (const s of u.sessions) if (s.address === address) return s;
  return null;
}
async function send(from: User, to: string, type: string, body: string) {
  const r = await api(from, "POST", "/v1/send", { to, type, body });
  if (r.status !== 202) throw new Error(`send ${from} -> ${to}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

/** Run team-up.sh for one user; returns its stdout (the summary). */
async function teamUp(u: User, extra: string[] = [], extraEnv: Record<string, string> = {}): Promise<string> {
  const args =
    u === "alex"
      ? ["--host-hub", "--hub-port", String(HUB)]
      : ["--hub-url", `http://127.0.0.1:${HUB}`];
  const r = await run(
    path.join(ROOT, "scripts", "team-up.sh"),
    [...args, "--user", u, "--daemon-port", String(PORT[u]), "--c4-session", session(u), "--no-ui", ...extra],
    {
      env: {
        ...process.env,
        AGENTLINK_DATA_DIR: dataDir(u),
        AGENTLINK_TOKEN: TOKEN,
        C4_TMUX_SOCKET: SOCKET,
        C4_STATE_DIR: c4Dir(u),
        ...extraEnv,
      },
      timeout: 60_000,
    },
  );
  return r.stdout;
}

const pidsOf = (u: User) =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(dataDir(u), "team.pids"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]),
  );
const localEnv = (u: User) => fs.readFileSync(path.join(dataDir(u), "local.env"), "utf8");

/** A ui-role hub socket, as the web UI opens it. Collects every frame. */
async function uiSocket(subscribe: string[] | "*") {
  const frames: { at: number; frame: ServerFrame }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${HUB}/ws`);
  ws.addEventListener("message", (ev) => {
    try {
      frames.push({ at: Date.now(), frame: JSON.parse(String(ev.data)) as ServerFrame });
    } catch {
      // ignore non-JSON
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ui socket failed to open")), { once: true });
  });
  ws.send(JSON.stringify({ op: "hello", token: TOKEN, role: "ui", user: "alex", protocol: PROTOCOL_VERSION }));
  await until("ui welcome", async () => frames.some((f) => f.frame.op === "welcome"), 5_000);
  ws.send(JSON.stringify({ op: "screens.subscribe", addresses: subscribe }));
  return { ws, frames, close: () => ws.close() };
}
type Screen = Extract<ServerFrame, { op: "screen" }>;
const screensFor = (frames: { at: number; frame: ServerFrame }[], address: string) =>
  frames.filter((f): f is { at: number; frame: Screen } => f.frame.op === "screen" && f.frame.address === address);

async function teamDown(u: User) {
  return run(path.join(ROOT, "scripts", "team-down.sh"), [], {
    env: { ...process.env, AGENTLINK_DATA_DIR: dataDir(u) },
    timeout: 30_000,
  }).catch((e) => e);
}

/** Stop just the bridge of one user (the pid team-up recorded), so team-up starts a fresh one. */
async function stopBridge(u: User) {
  const line = fs.readFileSync(path.join(dataDir(u), "team.pids"), "utf8").split("\n").find((l) => l.startsWith("bridge "));
  if (!line) throw new Error(`no bridge pid for ${u}`);
  const pid = Number(line.split(" ")[1]);
  process.kill(pid, "SIGTERM");
  await until(`${u} bridge to exit`, async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000);
}

/** A fake claude4 team: 5 panes running `cat`, a panes registry, and the pane options c4 uses. */
async function makeFakeTeam(u: User) {
  const s = session(u);
  await tmux("kill-session", "-t", s).catch(() => {});
  // `cat > /dev/null`: the terminal's echo shows a paste once; a bare `cat` would print it a second time.
  await tmux("new-session", "-d", "-s", s, "-x", "220", "-y", "50", "cat > /dev/null");
  for (let i = 0; i < 4; i++) await tmux("new-window", "-d", "-t", `${s}:`, "cat > /dev/null");
  const ids = (await tmux("list-panes", "-s", "-t", s, "-F", "#{pane_id}")).trim().split("\n");
  if (ids.length !== 5) throw new Error(`expected 5 panes in ${s}, got ${ids.length}`);
  // same layout as a real team: slots 1-4 are the quarters, slot 0 (the boss) is the orchestrator
  const slots = [1, 2, 3, 4, 0];
  slots.forEach((slot, i) => (panes[u][slot] = ids[i]));
  fs.mkdirSync(c4Dir(u), { recursive: true });
  fs.writeFileSync(path.join(c4Dir(u), "panes"), slots.map((slot, i) => `${slot} ${ids[i]}`).join("\n") + "\n");
  for (const slot of slots) {
    const p = panes[u][slot];
    await tmux("set", "-p", "-t", p, "@role", slot === 0 ? "orchestrator" : "worker");
    // the bridge sends a worker's @task only while it isn't idle/done, so the fake workers are "working"
    await tmux("set", "-p", "-t", p, "@state", slot === 0 ? "idle" : "working");
    if (slot !== 0) await tmux("set", "-p", "-t", p, "@task", `fake task ${slot}`);
  }
}

// ---------------------------------------------------------------- the test

async function main() {
  console.log(`two-team e2e: hub ${HUB}, alex ${PORT.alex}, sam ${PORT.sam}, tmp ${TMP}`);
  for (const p of [HUB, PORT.alex, PORT.sam]) {
    const busy = await run("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]).then(() => true, () => false);
    if (busy) throw new Error(`port ${p} is already in use; pick another AGENTLINK_BASE_PORT`);
  }

  await step("setup: fake c4 teams and team-up.sh for both users", async () => {
    for (const u of USERS) await makeFakeTeam(u);
    check("two tmux sessions with 5 cat panes each, registries written", true);
    const summary = { alex: await teamUp("alex"), sam: await teamUp("sam") };
    for (const u of USERS) {
      check(`${u}: summary says screens are not shared (no --share-screens)`, summary[u].includes("screens    not shared"), summary[u]);
      check(`${u}: local.env records AGENTLINK_SHARE_SCREENS=0`, localEnv(u).includes("AGENTLINK_SHARE_SCREENS=0"));
    }
    for (const u of USERS) {
      const h = (await api(u, "GET", "/v1/health")).body;
      check(`${u}: daemon connected to the hub`, h.hub.state === "connected", h.hub);
      const env = fs.readFileSync(path.join(dataDir(u), "local.env"), "utf8");
      check(`${u}: local.env has user and port, no token`, env.includes(`AGENTLINK_USER=${u}`) && env.includes(`AGENTLINK_DAEMON_PORT=${PORT[u]}`) && !env.includes(TOKEN));
      const mode = fs.statSync(path.join(dataDir(u), ".token")).mode & 0o777;
      check(`${u}: data/.token is private (${mode.toString(8)})`, mode === 0o600);
    }
    const before = fs.readFileSync(path.join(dataDir("alex"), "team.pids"), "utf8");
    await teamUp("alex");
    check("team-up.sh is idempotent (second run starts nothing new)", fs.readFileSync(path.join(dataDir("alex"), "team.pids"), "utf8") === before);
  });

  await step("1. all 10 sessions at the hub with the right kinds", async () => {
    const want = (u: User) => ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"].map((a) => `${u}/${a}`);
    const all = await until("10 sessions", async () => {
      const users = await sessionsAtHub();
      const got = users.flatMap((x) => x.sessions);
      return [...want("alex"), ...want("sam")].every((a) => got.some((s) => s.address === a && s.status !== "offline")) ? got : null;
    });
    for (const u of USERS) {
      for (const a of want(u)) {
        const s = all.find((x) => x.address === a)!;
        const kind = a.endsWith("/orchestrator") ? "orchestrator" : "worker";
        check(`${a}: kind ${s.kind}`, s.kind === kind, s);
      }
    }
    const w1 = all.find((x) => x.address === "alex/worker-1")!;
    check("worker task comes from the pane's @task", w1.task === "fake task 1", w1);
  });

  await step("2. @state on a fake pane changes the status at the hub", async () => {
    const p = panes.alex[2];
    await tmux("set", "-p", "-t", p, "@state", "blocked");
    const err = await until("alex/worker-2 error", async () => ((await hubSession("alex/worker-2"))?.status === "error" ? true : null), 15_000);
    check("@state blocked -> status error", err);
    await tmux("set", "-p", "-t", p, "@state", "asking");
    await until("alex/worker-2 waiting", async () => ((await hubSession("alex/worker-2"))?.status === "waiting" ? true : null), 15_000);
    check("@state asking -> status waiting", true);
    await tmux("set", "-p", "-t", p, "@task", "new task text");
    await until("task update", async () => ((await hubSession("alex/worker-2"))?.task === "new task text" ? true : null), 15_000);
    check("@task change reaches the hub", true);
    await tmux("set", "-p", "-t", p, "@state", "idle");
    await until("alex/worker-2 idle", async () => ((await hubSession("alex/worker-2"))?.status === "idle" ? true : null), 15_000);
    check("@state idle -> status idle", true);
  });

  let taskId = "";
  await step("3. sam/orchestrator's task lands in alex's slot-0 pane exactly once", async () => {
    taskId = await send("sam", "alex/orchestrator", "task", "two-team e2e: please list the open TODOs");
    const id8 = taskId.slice(0, 8);
    const header = `[agentlink task from sam/orchestrator · id ${id8}]`;
    // the Reply/Decline footer is the last line and only shows after the Enter, so wait for it
    await until("task pasted into alex slot 0", async () => {
      const s = await screen("alex", 0);
      return s.includes(header) && s.includes(`agentlink reply ${id8} `);
    });
    check("header pasted into alex's orchestrator pane", true);
    const shown = await screen("alex", 0);
    check("pasted with the remote-request banner", /REMOTE REQUEST/.test(shown), shown.slice(-600));
    check("pasted with the reply hint", shown.includes(`agentlink reply ${id8}`), shown.slice(-600));
    await sleep(7_000); // a couple of bridge cycles
    check("still exactly once after 7s", count(await screen("alex", 0), header) === 1, count(await screen("alex", 0), header));
    await stopBridge("alex");
    await teamUp("alex"); // starts only the bridge again
    await sleep(6_000);
    check("exactly once after a bridge restart (dedupe survives restarts)", count(await screen("alex", 0), header) === 1);
    let elsewhere = 0;
    for (const slot of [1, 2, 3, 4]) elsewhere += count(await screen("alex", slot), id8);
    check("not pasted into any worker pane", elsewhere === 0, elsewhere);
    const board = fs.readFileSync(path.join(c4Dir("alex"), "board.md"), "utf8");
    check("board.md got an 'agentlink ← sam/orchestrator' line", board.includes("**agentlink ← sam/orchestrator** task"), board.slice(-300));
  });

  await step("4. alex replies with bin/agentlink reply; it reaches sam's inbox and slot-0 pane", async () => {
    if (!taskId) throw new Error("no task from step 3");
    const id8 = taskId.slice(0, 8);
    const r = await run(path.join(ROOT, "bin", "agentlink"), ["reply", id8, "two-team e2e: here are the TODOs"], {
      env: { ...process.env, AGENTLINK_DATA_DIR: dataDir("alex"), AGENTLINK_DAEMON_PORT: String(PORT.alex), AGENTLINK_USER: "alex" },
      timeout: 20_000,
    }).catch((e) => e as { code: number; stdout: string; stderr: string });
    check("bin/agentlink reply exits 0", !("code" in r) || r.code === 0, r);
    const result = await until("result in sam's inbox", async () =>
      ((await api("sam", "GET", "/v1/inbox?agent=orchestrator&limit=1000")).body.messages as InboxItem[]).find(
        (m) => m.envelope.reply_to === taskId,
      ),
    );
    check(`sam: result from ${result.envelope.from}, type ${result.envelope.type}, reply_to = task id`, result.envelope.from === "alex/orchestrator" && result.envelope.type === "result", result.envelope);
    const header = `[agentlink result from alex/orchestrator · id ${result.envelope.id.slice(0, 8)}]`;
    await until("result pasted into sam slot 0", async () => (await screen("sam", 0)).includes(header));
    check("result pasted into sam's orchestrator pane", true);
    const alexItem = ((await api("alex", "GET", "/v1/inbox?agent=orchestrator&limit=1000")).body.messages as InboxItem[]).find(
      (m) => m.envelope.id === taskId,
    );
    check("alex's task marked handled by reply", alexItem?.handled === true, alexItem);
  });

  await step("5. worker addressing: orchestrator by default, slot 3 with DIRECT=1", async () => {
    const viaOrch = await send("sam", "alex/worker-3", "chat", "two-team e2e: for worker 3 (default mode)");
    const h1 = `[agentlink chat from sam/orchestrator · id ${viaOrch.slice(0, 8)}]`;
    await until("default-mode message in alex slot 0", async () => (await screen("alex", 0)).includes(h1));
    const s0 = await screen("alex", 0);
    check("default: message for alex/worker-3 goes to the orchestrator, labelled (for: alex/worker-3)", s0.includes("(for: alex/worker-3)"), s0.slice(-400));
    check("default: not pasted into slot 3", !(await screen("alex", 3)).includes(h1));

    const before = pidsOf("alex");
    const out = await teamUp("alex", ["--restart-bridge", "--direct"]);
    const after = pidsOf("alex");
    check("--restart-bridge: new bridge pid", !!after.bridge && after.bridge !== before.bridge, { before, after });
    check("--restart-bridge: hub and daemon untouched", after.hub === before.hub && after.daemon === before.daemon, { before, after });
    check("--restart-bridge: summary says so", out.includes("bridge restarted for alex") && out.includes("hub, daemon and UI untouched"), out);
    check("--restart-bridge --direct: recorded in local.env", localEnv("alex").includes("AGENTLINK_BRIDGE_DIRECT=1"));
    const direct = await send("sam", "alex/worker-3", "chat", "two-team e2e: for worker 3 (direct mode)");
    const h2 = `[agentlink chat from sam/orchestrator · id ${direct.slice(0, 8)}]`;
    await until("direct message in alex slot 3", async () => (await screen("alex", 3)).includes(h2));
    check("DIRECT=1: message for alex/worker-3 lands in slot 3", true);
    await sleep(3_000);
    check("DIRECT=1: not pasted into the orchestrator pane", !(await screen("alex", 0)).includes(h2));
    check("DIRECT=1: pasted once", count(await screen("alex", 3), h2) === 1);
  });

  await step("6. live screens: alex shares, sam doesn't; colours kept, secrets redacted", async () => {
    // Turn sharing on for alex with --restart-bridge, back in default mode (env beats local.env).
    const before = pidsOf("alex");
    const out = await teamUp("alex", ["--restart-bridge", "--share-screens"], { AGENTLINK_BRIDGE_DIRECT: "0" });
    const after = pidsOf("alex");
    check("alex: --restart-bridge --share-screens restarts only the bridge", after.bridge !== before.bridge && after.hub === before.hub && after.daemon === before.daemon, { before, after });
    check("alex: summary says screens are shared", out.includes("screens    shared with everyone on the hub"), out);
    check("alex: local.env records sharing on, direct off", localEnv("alex").includes("AGENTLINK_SHARE_SCREENS=1") && localEnv("alex").includes("AGENTLINK_BRIDGE_DIRECT=0"));

    const ui = await uiSocket(["alex/worker-1"]);
    const all = await uiSocket("*");
    try {
      // A pane that prints a red line and some secrets, then idles (pane id and @options survive respawn).
      const mark = `E2E-RED-${randomBytes(4).toString("hex")}`;
      const ghp = `ghp_${randomBytes(18).toString("hex")}`; // 36 chars after the prefix
      const script = [
        `printf '\\033[31m${mark}\\033[0m plain tail\\n'`,
        `printf 'AGENTLINK_TOKEN=${TOKEN}\\n'`,
        `printf 'bare token: ${TOKEN}\\n'`,
        `printf 'gh: ${ghp}\\n'`,
        `exec cat > /dev/null`,
      ].join("; ");
      const t0 = Date.now();
      await tmux("respawn-pane", "-k", "-t", panes.alex[1], script);
      const hit = await until("alex/worker-1 screen with the red line", async () =>
        screensFor(ui.frames, "alex/worker-1").find((f) => f.frame.screen.text.includes(mark)),
      10_000);
      const text = hit.frame.screen.text;
      check(`screen reached the ui socket within 3s (${hit.at - t0} ms)`, hit.at - t0 <= 3_000, hit.at - t0);
      check("colour kept: the line is wrapped in SGR red", new RegExp(`\\x1b\\[(?:[0-9;]*;)?31m${mark}`).test(text), JSON.stringify(text.slice(0, 300)));
      check("only SGR escapes in the text", [...text.matchAll(/\x1b(\[[0-9;]*[A-Za-z]|.)/g)].every((m) => /^\x1b\[[0-9;]*m$/.test(m[0])), JSON.stringify(text.slice(0, 300)));
      check("token value redacted (never appears)", !text.includes(TOKEN), "token found in screen text");
      check("TOKEN= line shows [redacted]", /AGENTLINK_TOKEN=\[redacted\]/.test(text), JSON.stringify(text.slice(0, 400)));
      check("bare token shows [redacted]", text.includes("bare token: [redacted]"), JSON.stringify(text.slice(0, 400)));
      check("ghp_ token redacted", !text.includes(ghp), "ghp token found");
      check("frame carries cols/rows/busy", hit.frame.screen.cols > 0 && hit.frame.screen.rows > 0 && typeof hit.frame.screen.busy === "boolean", hit.frame.screen);
      check("subscribed socket got only alex/worker-1 screens", ui.frames.every((f) => f.frame.op !== "screen" || f.frame.address === "alex/worker-1"));

      // Sam doesn't share: nothing from sam's panes, at the "*" socket or in the hub's screen list.
      await sleep(4_000);
      const samFrames = all.frames.filter((f) => (f.frame.op === "screen" || f.frame.op === "screen.gone") && f.frame.address.startsWith("sam/"));
      check("sam: no screen frames at a '*' subscriber after 4s", samFrames.length === 0, samFrames.map((f) => f.frame));
      const alexAddrs = new Set(all.frames.flatMap((f) => (f.frame.op === "screen" ? [f.frame.address] : [])));
      check("alex: all 5 panes stream to a '*' subscriber", ["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"].every((a) => alexAddrs.has(`alex/${a}`)), [...alexAddrs]);
      const listed = await fetch(`http://127.0.0.1:${HUB}/api/screens`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const infos = ((await listed.json()) as { screens: ScreenInfo[] }).screens;
      check("GET /api/screens lists alex's panes and none of sam's", infos.some((s) => s.address === "alex/worker-1") && !infos.some((s) => s.address.startsWith("sam/")), infos);
      check("GET /api/screens carries no text", infos.every((s) => !("text" in s)), infos[0]);

      // Typing in the pane (on our private tmux server) changes the screen.
      const upd = `E2E-UPDATED-${randomBytes(4).toString("hex")}`;
      const t1 = Date.now();
      await tmux("send-keys", "-t", panes.alex[1], "-l", upd);
      const changed = await until("updated screen", async () =>
        screensFor(ui.frames, "alex/worker-1").find((f) => f.at >= t1 && f.frame.screen.text.includes(upd)),
      10_000);
      check(`pane change shows up as a new screen (${changed.at - t1} ms)`, changed.at - t1 <= 3_000, changed.at - t1);

      // A message the person at alex's UI sends to worker-2 goes straight into slot 2, as their own.
      const body = `e2e from the UI ${randomBytes(3).toString("hex")}`;
      const r = await api("alex", "POST", "/v1/send", { from_agent: "human", to: "alex/worker-2", type: "chat", body });
      check("alex/human -> alex/worker-2 accepted by the daemon", r.status === 202, r);
      await until("UI message in alex slot 2", async () => (await screen("alex", 2)).includes(body));
      const s2 = await screen("alex", 2);
      check("slot 2 shows '[agentlink message from you (UI)]'", s2.includes("[agentlink message from you (UI)]"), s2.slice(-400));
      check("slot 2 shows no REMOTE banner", !/REMOTE REQUEST/.test(s2), s2.slice(-400));
      check("not pasted into the orchestrator pane", !(await screen("alex", 0)).includes(body));

      // Killing the pane ends its screen.
      const t2 = Date.now();
      await tmux("kill-pane", "-t", panes.alex[1]);
      const gone = await until("screen.gone for alex/worker-1", async () =>
        ui.frames.find((f) => f.at >= t2 && f.frame.op === "screen.gone" && f.frame.address === "alex/worker-1"),
      20_000);
      check(`killing the pane sends screen.gone (${gone.at - t2} ms)`, true);
    } finally {
      ui.close();
      all.close();
    }
  });
}

async function teardown() {
  console.log("\n== teardown");
  for (const u of ["sam", "alex"] as User[]) await teamDown(u);
  for (const u of USERS) await tmux("kill-session", "-t", session(u)).catch(() => {});
  fs.rmSync(path.join(TMP, "claude4"), { recursive: true, force: true });
  const onTestServer = await tmux("list-sessions", "-F", "#{session_name}").catch(() => "");
  const onDefault = await run("tmux", ["list-sessions", "-F", "#{session_name}"]).then((r) => r.stdout, () => "");
  check("no c4e2e tmux sessions left (test server and default server)", !/^c4e2e-/m.test(onTestServer + onDefault), onTestServer + onDefault);
  check("fake registries removed", USERS.every((u) => !fs.existsSync(c4Dir(u))));
  await sleep(500);
  const listeners = await run("lsof", ["-nP", `-iTCP:${HUB}-${PORT.sam}`, "-sTCP:LISTEN"]).then((r) => r.stdout, () => "");
  check(`no listeners on ${HUB}-${PORT.sam}`, listeners.trim() === "", listeners);
}

main()
  .catch((err) => {
    failures++;
    console.log(`FAIL  ${(err as Error).message}`);
  })
  .finally(async () => {
    await teardown();
    console.log(failures ? `\n${failures} check(s) failed (logs in ${TMP}/<user>/logs)` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
  });
