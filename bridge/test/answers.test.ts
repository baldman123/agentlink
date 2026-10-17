// Answers to the UI (contracts/bridge.md, "Answers to the UI"): the paste tells the pane to answer with
// `agentlink reply`, and when it doesn't, the bridge sends a short fallback result to <user>/human.
//   - a stub daemon on a random port (records POST /v1/send; serves outbox, history and the inbox stream)
//   - a PRIVATE tmux server (tmux -L c4test-answers) with panes running `cat`, so the real claude4 is never touched
//
// Run: npm test (from bridge/)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Envelope, InboxItem, SendRequest } from "../../contracts/index.ts";
import { AnswerWatch, paneTail, renderFallback } from "../src/answers.ts";
import type { BridgeConfig } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { AGENTLINK_BIN, renderLocalHuman } from "../src/inbound.ts";
import { initLog } from "../src/log.ts";
import { readTeam } from "../src/team.ts";
import { Tmux } from "../src/tmux.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = join(HERE, "..");
const ROOT = join(BRIDGE_DIR, "..");
const TSX_LOADER = `file://${join(ROOT, "node_modules/tsx/dist/loader.mjs")}`;
const SOCK = "c4test-answers";
const tmp = mkdtempSync(join(tmpdir(), "agentlink-answers-test-"));
const stateDir = join(tmp, "c4state");
mkdirSync(stateDir, { recursive: true });
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
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

const tmuxCmd = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" }).trim();

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    id: randomUUID(),
    from: "alex/human",
    to: "alex/orchestrator",
    reply_to: null,
    hops: 0,
    type: "chat",
    body: "what's the status?",
    timestamp: new Date().toISOString(),
    ...over,
  };
}
const inboxItem = (e: Envelope): InboxItem => ({ envelope: e, received_at: new Date().toISOString(), handled: false, remote: false });

/** Stub daemon: what the bridge calls, plus knobs for the outbox, the hub history and a failing history. */
async function startStub() {
  const sends: SendRequest[] = [];
  const state = { outbox: [] as Envelope[], history: [] as Envelope[], historyFails: false };
  const streams = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url ?? "/", "http://stub");
    const json = (code: number, v: unknown) => void res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "POST" && url.pathname === "/v1/send") {
      sends.push(JSON.parse(body));
      return json(202, { id: randomUUID(), queued: true });
    }
    if (url.pathname === "/v1/outbox") return json(200, { items: state.outbox.map((envelope) => ({ envelope, attempts: 0, next_attempt_at: "", last_error: null })) });
    if (url.pathname === "/v1/messages") {
      if (state.historyFails) return json(502, { error: "hub_unreachable" });
      const a = url.searchParams.get("address");
      return json(200, { messages: state.history.filter((m) => m.to === a || m.from === a).reverse() });
    }
    if (url.pathname.startsWith("/v1/sessions/")) return req.method === "DELETE" ? void res.writeHead(204).end() : json(200, {});
    if (url.pathname === "/v1/inbox/stream" || url.pathname === "/v1/panes/input/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      if (url.pathname === "/v1/inbox/stream") {
        streams.add(res);
        res.on("close", () => streams.delete(res));
      }
      return;
    }
    if (url.pathname === "/v1/inbox") return json(200, { messages: [] });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    sends,
    state,
    push: (item: InboxItem) => {
      for (const s of streams) s.write(`event: message\ndata: ${JSON.stringify(item)}\n\n`);
    },
    streams: () => streams.size,
    close: () =>
      new Promise<void>((r) => {
        for (const s of streams) s.end();
        server.close(() => r());
      }),
  };
}

const panes: string[] = [];
const paneFile = (i: number) => join(tmp, `pane${i}.txt`);
function writeRegistry() {
  writeFileSync(join(stateDir, "panes"), panes.map((p, i) => `${i} ${p}`).join("\n") + "\n");
}
/** Replace what a pane shows (respawn keeps the pane id). */
function showOnPane(i: number, text: string) {
  writeFileSync(join(tmp, `show${i}.txt`), text);
  tmuxCmd("respawn-pane", "-k", "-t", panes[i], `cat '${join(tmp, `show${i}.txt`)}'; exec cat >> '${paneFile(i)}'`);
}

const children: ChildProcess[] = [];
let stub: Awaited<ReturnType<typeof startStub>> | null = null;

try {
  initLog(join(tmp, "unit.log"), "alex");

  console.error("paste text");
  const e0 = envelope({ body: "status update please" });
  const text = renderLocalHuman(inboxItem(e0));
  check(text.startsWith("[agentlink message from you (UI)]\nstatus update please\n"), "header, then the person's words", text);
  check(text.includes(`${AGENTLINK_BIN} reply ${e0.id.slice(0, 8)} "<your answer>"`), "reply command uses the full path to bin/agentlink", text);
  check(AGENTLINK_BIN === join(ROOT, "bin", "agentlink") && existsSync(AGENTLINK_BIN), "that path is this repo's bin/agentlink and exists", AGENTLINK_BIN);
  check(/reading there, not in this pane/.test(text) && /never reaches them/.test(text), "says plainly the answer must go back through the app", text);

  console.error("pane tail");
  const claudeScreen = [
    "\u001b[1m⏺ Status:\u001b[0m all four workers are done.",
    "  The PR is ready: AGENTLINK_TOKEN=abc123secretvalue",
    "",
    "  Next step: Bryant reviews it.",
    "",
    "─".repeat(80),
    "❯ half-typed draft that must not leave",
    "─".repeat(80),
    "  ? for shortcuts",
    "",
    "",
  ].join("\n");
  const tail = paneTail(claudeScreen, null);
  check(tail.includes("⏺ Status: all four workers are done.") && tail.includes("Next step: Bryant reviews it."), "keeps the answer, escape codes stripped", tail);
  check(!tail.includes("draft") && !tail.includes("for shortcuts") && !tail.includes("──"), "input box, its draft and the footer are cut off", tail);
  check(!tail.includes("abc123secretvalue") && tail.includes("AGENTLINK_TOKEN=[redacted]"), "secrets are redacted", tail);
  check(paneTail(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), null).split("\n").length === 12, "at most 12 lines");
  check(paneTail("my token is tok_abcdef123", "tok_abcdef123") === "my token is [redacted]", "the shared token is redacted");
  const fb = renderFallback("orchestrator", "a\n```\nb");
  check(fb.startsWith("The boss answered in its terminal pane only") && fb.includes("````\na\n```\nb\n````"), "fallback text names the boss and fences safely", fb);
  check(renderFallback("worker-3", "x").startsWith("Worker 3 answered"), "a worker is named as Worker N");

  console.error("setup: stub daemon + tmux -L " + SOCK);
  stub = await startStub();
  panes.push(tmuxCmd("new-session", "-d", "-s", "answers", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}", `cat >> '${paneFile(0)}'`));
  panes.push(tmuxCmd("split-window", "-t", "answers:", "-P", "-F", "#{pane_id}", `cat >> '${paneFile(1)}'`));
  tmuxCmd("set", "-p", "-t", panes[0], "@role", "orchestrator");
  writeRegistry();

  const cfg = {
    user: "alex",
    stateDir,
    answerFallback: true,
    answerWaitMs: 400,
    answerCheckMs: 100,
  } as BridgeConfig;
  const tmux = new Tmux(SOCK);
  const daemon = new Daemon(`http://127.0.0.1:${stub.port}`);
  const team = await readTeam(tmux, stateDir);
  const boss = team.find((s) => s.agent === "orchestrator")!;
  const w1 = team.find((s) => s.agent === "worker-1")!;
  check(boss && w1, "fake team has a boss and worker-1", team);
  const watch = new AnswerWatch(cfg, tmux, daemon, null);
  const settle = async (ms = 900) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await watch.check();
      await sleep(50);
    }
  };

  console.error("answer watch");
  showOnPane(0, "⏺ Everything is merged into the team branch.\nThe answer is 42.\n");
  const a = envelope();
  watch.track(inboxItem(a), boss);
  await settle();
  const sA = stub.sends.find((s) => s.reply_to === a.id);
  check(sA && sA.to === "alex/human" && sA.type === "result" && sA.from_agent === "orchestrator" && sA.hops === 1, "no reply + idle boss -> one result to alex/human, reply_to set", sA);
  const sAtext = (sA?.body as { text?: string })?.text ?? "";
  check(sAtext.includes("The boss answered in its terminal pane only") && sAtext.includes("The answer is 42."), "the result quotes the end of the boss pane", sAtext);
  check(watch.watching === 0 && stub.sends.filter((s) => s.reply_to === a.id).length === 1, "sent once, then forgotten");

  const b = envelope();
  watch.track(inboxItem(b), boss);
  stub.state.history.push(envelope({ from: "alex/orchestrator", to: "alex/human", type: "chat", body: "42", reply_to: b.id }));
  await settle();
  check(!stub.sends.some((s) => s.reply_to === b.id) && watch.watching === 0, "a reply in the hub history (reply_to) -> nothing sent");

  const c = envelope();
  watch.track(inboxItem(c), boss);
  stub.state.outbox.push(envelope({ from: "alex/orchestrator", to: "alex/human", type: "result", body: "42", reply_to: c.id }));
  await settle();
  check(!stub.sends.some((s) => s.reply_to === c.id) && watch.watching === 0, "a reply still in the outbox -> nothing sent");

  stub.state.history = [];
  stub.state.outbox = [];
  const d = envelope();
  watch.track(inboxItem(d), boss);
  await sleep(20);
  stub.state.history.push(envelope({ from: "alex/orchestrator", to: "alex/human", type: "chat", body: "sent without reply_to" }));
  await settle();
  check(!stub.sends.some((s) => s.reply_to === d.id) && watch.watching === 0, "any boss message to alex/human after the paste counts as the answer");

  const old = envelope({ from: "alex/orchestrator", to: "alex/human", type: "chat", body: "old", timestamp: new Date(Date.now() - 60_000).toISOString() });
  stub.state.history = [old];
  stub.state.outbox = [];
  showOnPane(0, "✻ Thinking… (12s · esc to interrupt)\n");
  const f = envelope();
  watch.track(inboxItem(f), boss);
  await settle();
  check(!stub.sends.some((s) => s.reply_to === f.id) && watch.watching === 1, "while the boss is busy, no fallback (and an older message doesn't count)");
  showOnPane(0, "⏺ Done thinking. It's fine.\n");
  await settle(150);
  check(!stub.sends.some((s) => s.reply_to === f.id), "just went idle: still waiting out the idle time");
  await settle();
  check(stub.sends.some((s) => s.reply_to === f.id), "idle for the full wait -> fallback");

  stub.state.historyFails = true;
  const g = envelope();
  watch.track(inboxItem(g), boss);
  await settle();
  check(!stub.sends.some((s) => s.reply_to === g.id) && watch.watching === 1, "hub history unreachable -> no fallback (a reply might be invisible)");
  stub.state.historyFails = false;
  await settle();
  check(stub.sends.some((s) => s.reply_to === g.id), "...and it goes out once the history is readable again");

  const h = envelope({ to: "alex/worker-1" });
  showOnPane(1, "⏺ Linted, 0 problems.\n");
  watch.track(inboxItem(h), w1);
  await settle();
  const sH = stub.sends.find((s) => s.reply_to === h.id);
  check(sH?.from_agent === "worker-1" && (sH.body as { text: string }).text.startsWith("Worker 1 answered"), "a UI message to a worker gets the same fallback, from that worker", sH);

  const i = envelope();
  watch.track(inboxItem(i), { ...boss, pane: "%99999" });
  await settle(300);
  check(!stub.sends.some((s) => s.reply_to === i.id) && watch.watching === 0, "pane gone -> stop watching, nothing sent");

  console.error("bridge process (end to end)");
  showOnPane(0, "");
  const runBridge = async (fallback: "1" | "0") => {
    const { AGENTLINK_TOKEN: _t, AGENTLINK_SHARE_SCREENS: _s, ...base } = process.env;
    const child = spawn(process.execPath, ["--import", TSX_LOADER, "src/index.ts"], {
      cwd: BRIDGE_DIR,
      env: {
        ...base,
        AGENTLINK_USER: "alex",
        AGENTLINK_DAEMON_PORT: String(stub!.port),
        C4_SESSION: "answers",
        C4_STATE_DIR: stateDir,
        C4_TMUX_SOCKET: SOCK,
        AGENTLINK_BRIDGE_DB: join(tmp, `bridge-${fallback}.json`),
        AGENTLINK_BRIDGE_LOG: join(tmp, `bridge-${fallback}.log`),
        AGENTLINK_BRIDGE_SYNC_MS: "300",
        AGENTLINK_BRIDGE_ANSWER_FALLBACK: fallback,
        AGENTLINK_BRIDGE_ANSWER_WAIT_MS: "500",
        AGENTLINK_BRIDGE_ANSWER_CHECK_MS: "100",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    children.push(child);
    await until(() => stub!.streams(), (n) => n > 0);
    const e = envelope({ body: `ping ${fallback}` });
    stub!.push(inboxItem(e));
    const pasted = await until(() => (existsSync(paneFile(0)) ? readFileSync(paneFile(0), "utf8") : ""), (s) => s.includes(`reply ${e.id.slice(0, 8)} `));
    await sleep(1_500);
    child.kill("SIGTERM");
    await until(() => child.exitCode, (x) => x !== null, 5_000);
    return { e, pasted, log: readFileSync(join(tmp, `bridge-${fallback}.log`), "utf8") };
  };
  const on = await runBridge("1");
  check(on.pasted.includes(`${AGENTLINK_BIN} reply ${on.e.id.slice(0, 8)} `), "the bridge pastes the UI message with the full-path reply command", on.pasted.slice(-400));
  check(stub.sends.some((s) => s.reply_to === on.e.id && s.to === "alex/human"), "the bridge sends the fallback when the boss never replies", stub.sends.slice(-2));
  check(on.log.includes('"event":"answer.fallback_sent"'), "and logs answer.fallback_sent");
  const off = await runBridge("0");
  check(off.pasted.includes(`reply ${off.e.id.slice(0, 8)} `) && !stub.sends.some((s) => s.reply_to === off.e.id), "AGENTLINK_BRIDGE_ANSWER_FALLBACK=0 -> pasted, but no fallback", stub.sends.slice(-2));
} catch (err) {
  failures++;
  console.error("  FAIL (exception)", err);
} finally {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  try {
    execFileSync("tmux", ["-L", SOCK, "kill-server"], { stdio: "ignore" });
  } catch {}
  await stub?.close();
  rmSync(tmp, { recursive: true, force: true });
  console.error(`\nanswers: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
