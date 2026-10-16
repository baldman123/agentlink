// Local terminal input (contracts/input.md), daemon side: fake hub + alex and sam daemons on test ports.
//   npx tsx daemon/test/input-e2e.ts        (E2E_BASE, default 7790: hub, +1 alex, +2 sam)
// Plays both the UI (Origin = the UI origin, X-Agentlink-Input) and the bridge (SSE stream, results).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN = "input-e2e-token";
const HUB_PORT = Number(process.env.E2E_BASE ?? 7790);
const PORTS = { alex: HUB_PORT + 1, sam: HUB_PORT + 2 } as const;
type User = keyof typeof PORTS;
const UI = "http://127.0.0.1:7780"; // the daemon's default AGENTLINK_UI_ORIGIN
const SECRET = `do-not-log-${Math.random().toString(36).slice(2)} rm -rf nothing`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-input-e2e-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
const procs: ChildProcess[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(name: string, args: string[], cwd: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ["--import", TSX_LOADER, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(path.join(tmp, `${name}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}
function startDaemon(user: User) {
  return run(user, [path.join(daemonDir, "src/index.ts")], tmp, {
    AGENTLINK_USER: user,
    AGENTLINK_TOKEN: TOKEN,
    AGENTLINK_HUB_URL: `http://127.0.0.1:${HUB_PORT}`,
    AGENTLINK_DISCOVERY: "manual",
    AGENTLINK_DAEMON_PORT: String(PORTS[user]),
    AGENTLINK_DAEMON_DB: path.join(tmp, `daemon-${user}.sqlite`),
    AGENTLINK_INPUT_RESULT_MS: "1500",
  });
}
async function stop(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const done = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await done;
}

async function api(user: User, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORTS[user]}${p}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
const uiPost = (body: unknown, headers: Record<string, string> = { origin: UI, "x-agentlink-input": "1" }) =>
  api("alex", "POST", "/v1/panes/input", body, headers);

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The bridge's side: an SSE client on /v1/panes/input/stream. */
class Bridge {
  events: { id: string; agents: string[]; text: string; submit: boolean }[] = [];
  status = 0;
  ended = false;
  private req: http.ClientRequest;
  constructor(headers: Record<string, string> = {}) {
    this.req = http.get({ host: "127.0.0.1", port: PORTS.alex, path: "/v1/panes/input/stream", headers }, (res) => {
      this.status = res.statusCode ?? 0;
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!chunk.includes("event: input")) continue;
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (data) this.events.push(JSON.parse(data.slice(6)));
        }
      });
      res.on("end", () => (this.ended = true));
    });
    this.req.on("error", () => (this.ended = true));
  }
  ready() {
    return until("bridge stream open", async () => this.status !== 0);
  }
  close() {
    this.req.destroy();
  }
}

async function main() {
  run("hub", ["test/fake-hub.ts"], daemonDir, { AGENTLINK_TOKEN: TOKEN, FAKE_HUB_PORT: String(HUB_PORT) });
  startDaemon("alex");
  startDaemon("sam");
  for (const u of ["alex", "sam"] as User[]) await until(`${u} connected`, async () => (await api(u, "GET", "/v1/health")).body.hub.state === "connected");
  const good = { agents: ["orchestrator", "worker-1"], text: SECRET };

  // guards
  let r = await uiPost(good, { "x-agentlink-input": "1" });
  check("no Origin -> 403", r.status === 403 && r.body.error === "forbidden_origin", r.body);
  r = await uiPost(good, { origin: "http://localhost:5173", "x-agentlink-input": "1" });
  check("another localhost origin -> 403", r.status === 403 && r.body.error === "forbidden_origin", r.body);
  r = await uiPost(good, { origin: UI });
  check("missing X-Agentlink-Input -> 403", r.status === 403 && r.body.error === "missing_header", r.body);
  r = await uiPost(good, { origin: UI, "x-agentlink-input": "yes" });
  check("X-Agentlink-Input other than 1 -> 403", r.status === 403, r.body);
  r = await uiPost(good);
  check("no bridge connected -> 503 no_bridge", r.status === 503 && r.body.error === "no_bridge", r.body);
  const pre = await api("alex", "OPTIONS", "/v1/panes/input", undefined, { origin: UI, "access-control-request-headers": "x-agentlink-input" });
  check("preflight from the UI origin allows X-Agentlink-Input", (pre.headers.get("access-control-allow-headers") ?? "").includes("x-agentlink-input"));
  const pre2 = await api("alex", "OPTIONS", "/v1/panes/input", undefined, { origin: "http://localhost:5173", "access-control-request-headers": "x-agentlink-input" });
  check("preflight from another localhost origin does not", !(pre2.headers.get("access-control-allow-headers") ?? "").includes("x-agentlink-input"));
  const pre3 = await api("alex", "OPTIONS", "/v1/screens/worker-1", undefined, { origin: UI });
  check("preflight on other endpoints does not either", !(pre3.headers.get("access-control-allow-headers") ?? "").includes("x-agentlink-input"));

  const pageBridge = new Bridge({ origin: "http://localhost:5173" });
  await pageBridge.ready();
  check("stream with an Origin header (a web page) -> 403", pageBridge.status === 403);
  pageBridge.close();

  // a real bridge
  let bridge = new Bridge();
  await bridge.ready();
  check("bridge stream opens (200)", bridge.status === 200);
  r = await uiPost({ agents: ["orchestrator"], text: "" });
  check("empty text -> 400", r.status === 400, r.body);
  r = await uiPost({ agents: ["orchestrator"], text: "x".repeat(4001) });
  check("text over 4000 chars -> 400", r.status === 400, r.body);
  r = await uiPost({ agents: ["sam/orchestrator"], text: "x" });
  check("agent that isn't a local name -> 400", r.status === 400, r.body);
  r = await uiPost({ agents: [], text: "x" });
  check("no agents -> 400", r.status === 400, r.body);
  r = await uiPost({ agents: ["orchestrator"], text: "x", submit: "yes" });
  check("non-boolean submit -> 400", r.status === 400, r.body);

  r = await uiPost(good);
  check("valid request -> 202 {id}", r.status === 202 && typeof r.body.id === "string", r.body);
  const id = r.body.id as string;
  const ev = await until("input event", async () => bridge.events.find((e) => e.id === id));
  check("bridge stream receives {id, agents, text, submit}", ev.text === SECRET && ev.submit === true && ev.agents.join() === "orchestrator,worker-1", ev);
  check("GET status while waiting -> pending", (await api("alex", "GET", `/v1/panes/input/${id}`)).body.state === "pending");
  r = await api("alex", "POST", `/v1/panes/input/${id}/result`, { results: { orchestrator: "sent" } }, { origin: UI });
  check("result from a browser origin -> 403", r.status === 403, r.body);
  r = await api("alex", "POST", `/v1/panes/input/${id}/result`, { results: { orchestrator: "sent", "worker-1": "skipped: prompt_open" } });
  check("bridge posts the result -> 204", r.status === 204, r.body);
  r = await api("alex", "GET", `/v1/panes/input/${id}`);
  check("GET status -> done with per-agent results", r.body.state === "done" && r.body.results.orchestrator === "sent" && r.body.results["worker-1"] === "skipped: prompt_open", r.body);
  check("status never echoes the text", !JSON.stringify(r.body).includes(SECRET));
  check("second result for the same id -> 409", (await api("alex", "POST", `/v1/panes/input/${id}/result`, { results: { orchestrator: "sent" } })).status === 409);
  check("result for an unknown id -> 404", (await api("alex", "POST", `/v1/panes/input/00000000-0000-0000-0000-000000000000/result`, { results: {} })).status === 404);

  // submit:false passes through; a request with no result fails after the (shortened) wait
  r = await uiPost({ agents: ["worker-2"], text: "partial", submit: false });
  const id2 = r.body.id as string;
  const ev2 = await until("second event", async () => bridge.events.find((e) => e.id === id2));
  check("submit:false reaches the bridge", ev2.submit === false);
  const failed = await until("no_result failure", async () => {
    const s = (await api("alex", "GET", `/v1/panes/input/${id2}`)).body;
    return s.state === "failed" ? s : null;
  }, 6_000);
  check("delivered with no result -> failed: no_result", failed.results["worker-2"] === "failed: no_result", failed);

  // newest bridge wins
  const bridge2 = new Bridge();
  await bridge2.ready();
  await until("old stream ended", async () => bridge.ended, 5_000);
  check("a newer bridge connection ends the older one", bridge.ended);
  r = await uiPost({ agents: ["worker-3"], text: "to the new bridge" });
  await until("event on new bridge", async () => bridge2.events.find((e) => e.id === r.body.id));
  check("requests go to the newest bridge only", !bridge.events.some((e) => e.id === r.body.id));
  bridge = bridge2;

  // nothing from the hub reaches the input channel
  const before = bridge.events.length;
  const sent = await api("sam", "POST", "/v1/send", { to: "alex/orchestrator", type: "task", body: "/clear" });
  await api("sam", "POST", "/v1/send", { to: "alex/*", type: "chat", body: { text: "/clear", agents: ["orchestrator"], submit: true } });
  await until("hub message in alex's inbox", async () =>
    ((await api("alex", "GET", "/v1/inbox?limit=1000")).body.messages as any[]).some((m) => m.envelope.id === sent.body.id),
  );
  await sleep(1500);
  check("remote messages from the hub never reach the input stream", bridge.events.length === before, bridge.events.slice(before));
  bridge.close();
  await until("bridge gone", async () => (await uiPost(good)).status === 503, 5_000);
  check("after the bridge disconnects, input -> 503 no_bridge", true);

  // logs
  const logText = fs.readFileSync(path.join(tmp, "logs", "daemon-alex.log"), "utf8") + fs.readFileSync(path.join(tmp, "alex.out"), "utf8");
  check("the typed text is not in the daemon log or stdout", !logText.includes(SECRET) && !logText.includes("to the new bridge"));
  const reqLine = logText.split("\n").find((l) => l.includes('"input.requested"') && l.includes(id));
  check("input.requested is logged with id, agents and chars", !!reqLine && reqLine.includes(`"chars":${SECRET.length}`) && reqLine.includes("worker-1"), reqLine);
}

main()
  .catch((err) => {
    failures++;
    console.log(`FAIL  ${(err as Error).message}`);
  })
  .finally(async () => {
    await Promise.all(procs.map(stop));
    console.log(failures ? `\n${failures} failure(s); logs in ${tmp}` : "\nall passed");
    process.exit(failures ? 1 : 0);
  });
