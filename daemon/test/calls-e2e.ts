// End-to-end "Your calls": a fake claude4 inbox -> the daemon's CallRelay -> the website's real /api/calls routes
// (in-memory store, over HTTP) -> an answer on the site -> the fake inbox gets `c4 decide` / `c4 answer`, and both
// sides stay in sync. Run: npx tsx daemon/test/calls-e2e.ts
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setDeps } from "../../cloud/lib/server/deps.ts";
import { MemoryStore, RecordingBroadcaster } from "../../cloud/test/memory-store.ts";
import * as login from "../../cloud/app/api/auth/login/route.ts";
import * as people from "../../cloud/app/api/admin/people/route.ts";
import * as calls from "../../cloud/app/api/calls/route.ts";
import * as sync from "../../cloud/app/api/calls/sync/route.ts";
import * as answer from "../../cloud/app/api/calls/[id]/answer/route.ts";
import { CallRelay, c4Runner, readCalls } from "../src/calls.ts";
import type { DaemonHubLink } from "../src/link.ts";

let passes = 0;
let failures = 0;
function check(cond: unknown, name: string, detail?: unknown) {
  if (cond) {
    passes++;
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 8_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------- the website: real routes, memory store
const MASTER = "master-code-for-tests-0123456789";
setDeps({
  env: { owner: "bryant", masterCode: MASTER, sessionSecret: "s".repeat(40), supabaseUrl: "https://sb.test", supabaseAnonKey: "anon", supabaseServiceKey: "svc", supabaseJwtSecret: "j".repeat(40), hubName: "test" },
  store: new MemoryStore(),
  broadcaster: new RecordingBroadcaster(),
  now: () => Date.now(),
});
type Handler = (req: Request, ctx: any) => Promise<Response>;
function routeFor(method: string, p: string): { h: Handler; params: Record<string, string> } | null {
  if (method === "POST" && p === "/api/auth/login") return { h: login.POST, params: {} };
  if (method === "POST" && p === "/api/admin/people") return { h: people.POST, params: {} };
  if (method === "GET" && p === "/api/calls") return { h: calls.GET, params: {} };
  if (method === "PUT" && p === "/api/calls/sync") return { h: sync.PUT, params: {} };
  const m = p.match(/^\/api\/calls\/([^/]+)\/answer$/);
  if (method === "POST" && m) return { h: answer.POST, params: { id: decodeURIComponent(m[1]) } };
  return null;
}
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url!, "http://site.test");
  const r = routeFor(req.method!, url.pathname);
  if (!r) return void res.writeHead(404).end();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-forwarded-proto", "https");
  headers.set("host", "site.test");
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const out = await r.h(new Request(`https://site.test${url.pathname}${url.search}`, { method: req.method, headers, body }), { params: Promise.resolve(r.params) });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function api(method: string, p: string, o: { body?: unknown; bearer?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.cookie) {
    headers.cookie = `al_session=${o.cookie}`;
    headers.origin = "https://site.test";
  }
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + p, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const signIn = async (code: string) => (await api("POST", "/api/auth/login", { body: { code } })).body.session as string;
const bryant = await signIn(MASTER);
const sam = await signIn((await api("POST", "/api/admin/people", { bearer: bryant, body: { user: "sam" } })).body.code);
const siteCalls = async (s = bryant) => (await api("GET", "/api/calls", { cookie: s })).body.calls as any[];

// ---------------------------------------------------------------- a fake claude4: state dir + c4 decide/answer
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "al-calls-"));
const state = path.join(tmp, "claude4web");
fs.mkdirSync(path.join(state, "requests"), { recursive: true });
fs.mkdirSync(path.join(state, "questions"), { recursive: true });
const c4Log = path.join(tmp, "c4.log");
const c4 = path.join(tmp, "c4");
// Same files and refusals as ~/.local/bin/c4 decide|answer; also records how it was called.
fs.writeFileSync(
  c4,
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const [cmd, id, ...rest] = process.argv.slice(2);
const state = ${JSON.stringify(state)};
fs.appendFileSync(${JSON.stringify(c4Log)}, JSON.stringify({ args: process.argv.slice(2), session: process.env.C4_SESSION, pane: process.env.TMUX_PANE }) + "\\n");
if (process.env.TMUX_PANE) { console.error("c4: only Bryant answers these"); process.exit(1); }
if (cmd === "decide") {
  const f = path.join(state, "requests", id + ".bryant");
  if (fs.existsSync(f)) { console.error("c4: request #" + id + " was already answered"); process.exit(1); }
  fs.writeFileSync(f, rest[0] + "\\n" + rest.slice(1).join(" ") + "\\n");
  console.log("Request #" + id + ": " + (rest[0] === "approve" ? "approved" : "denied") + ".");
} else if (cmd === "answer") {
  const f = path.join(state, "questions", id + ".answer");
  if (fs.existsSync(f)) { console.error("c4: question #" + id + " was already answered"); process.exit(1); }
  fs.writeFileSync(f, rest.join(" ") + "\\n");
  console.log("Answered #" + id + ".");
} else process.exit(2);
`,
);
fs.chmodSync(c4, 0o755);
const c4Calls = () => (fs.existsSync(c4Log) ? fs.readFileSync(c4Log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const writeReq = (id: string, o: Record<string, unknown>) =>
  fs.writeFileSync(path.join(state, "requests", `${id}.json`), JSON.stringify({ id, slot: 2, tool: "Bash", what: "Bash: git push origin feature", why: "sends data to a server", lane: "user", needsBryant: true, cwd: "/x", t: Date.now(), ...o }));
const writeQ = (id: string, o: Record<string, unknown>) => fs.writeFileSync(path.join(state, "questions", `${id}.json`), JSON.stringify({ id, from: 0, t: Date.now(), ...o }));

// ---------------------------------------------------------------- the daemon side
const hub = Object.assign(new EventEmitter(), {
  connected: true,
  async rest(method: string, p: string, body?: unknown) {
    return api(method, p, { body, bearer: bryant });
  },
}) as unknown as DaemonHubLink;
const relay = new CallRelay(hub, state, c4Runner(c4, "claude4web"), 200, 1_000, 100);

try {
  // 1. calls waiting in claude4 appear on the site, plain English first
  writeReq("2abcd", { summary: "Quarter 2 wants to push your branch to GitHub, where others can see it; Yes lets it push.", detail: "Bash: git push origin feature" });
  writeQ("q01234", { text: "Buy agentlink.dev for $12? Options: yes, or pick another name.", summary: "The boss wants to spend $12 on a domain; Yes buys it." });
  writeReq("2done", { summary: "already handled" });
  fs.writeFileSync(path.join(state, "requests", "2done.bryant"), "approve\n");
  writeReq("1coord", { needsBryant: false, lane: "coordinator" }); // the boss's to decide, not Bryant's
  relay.start();
  check(await until(async () => (await siteCalls()).length === 2), "the two calls waiting on Bryant appear on the site");
  const listed = await siteCalls();
  const p = listed.find((c) => c.id === "2abcd");
  check(p?.summary.startsWith("Quarter 2 wants to push") && p.details === "Bash: git push origin feature" && p.from === "quarter 2" && p.kind === "permission", "a request shows its plain-English summary, with the command as details", p);
  const q = listed.find((c) => c.id === "q01234");
  check(q?.summary === "The boss wants to spend $12 on a domain; Yes buys it." && q.details.includes("Buy agentlink.dev") && q.from === "the boss", "a question shows its summary, with the full question as details", q);
  check(!listed.some((c) => c.id === "2done" || c.id === "1coord"), "answered requests and the boss's own requests stay off the site");
  check((await siteCalls(sam)).length === 0, "nobody else sees this team's calls");

  // 2. Yes on the site -> c4 decide approve, exactly as the boss circle would; then gone from the site
  const yes = await api("POST", "/api/calls/2abcd/answer", { cookie: bryant, body: { choice: "yes", note: "ok to push" } });
  check(yes.status === 200 && yes.body.call.state === "answering", "Yes on the site is accepted", yes);
  const bryantFile = path.join(state, "requests", "2abcd.bryant");
  check(await until(() => fs.existsSync(bryantFile)), "the fake claude4 gets the decision");
  check(fs.existsSync(bryantFile) && fs.readFileSync(bryantFile, "utf8") === "approve\nok to push\n", "...as approve plus the note, the way c4 decide writes it", fs.existsSync(bryantFile) && fs.readFileSync(bryantFile, "utf8"));
  const first = c4Calls()[0];
  check(first?.args.join(" ") === "decide 2abcd approve ok to push" && first.session === "claude4web" && first.pane === "", "c4 ran as the boss circle runs it (C4_SESSION set, TMUX_PANE empty)", first);
  check(await until(async () => !(await siteCalls()).some((c) => c.id === "2abcd")), "once delivered, the call leaves the site");
  await sleep(600);
  check(c4Calls().filter((c) => c.args[1] === "2abcd").length === 1, "it is delivered once");

  // 3. answered on the boss circle -> gone from the site
  fs.writeFileSync(path.join(state, "questions", "q01234.answer"), "yes\n");
  check(await until(async () => (await siteCalls()).length === 0), "a call answered on the boss circle leaves the site");
  check(!c4Calls().some((c) => c.args[1] === "q01234"), "...and nothing is sent to claude4 for it");

  // 4. No with a note -> deny with the reason; a free-text question answer -> c4 answer with the text
  writeReq("3efgh", { tool: "Write", why: "outside the project" }); // no summary: the fallback sentence
  writeQ("q05678", { text: "Which colour for the header: blue or green?" });
  check(await until(async () => (await siteCalls()).length === 2), "new calls appear");
  const fb = (await siteCalls()).find((c) => c.id === "3efgh");
  check(fb?.summary === "Quarter 2 wants to change a file (outside the project). Yes lets it go ahead; No stops it.", "a request without a summary gets a plain-English one", fb?.summary);
  const qd = (await siteCalls()).find((c) => c.id === "q05678");
  check(qd?.summary === "Which colour for the header: blue or green?" && qd.details === "", "a question without a summary shows the question itself");
  await api("POST", "/api/calls/3efgh/answer", { cookie: bryant, body: { choice: "no", note: "keep it in the repo" } });
  await api("POST", "/api/calls/q05678/answer", { cookie: bryant, body: { note: "green" } });
  check(await until(() => fs.existsSync(path.join(state, "requests", "3efgh.bryant")) && fs.existsSync(path.join(state, "questions", "q05678.answer"))), "both answers reach claude4");
  check(fs.readFileSync(path.join(state, "requests", "3efgh.bryant"), "utf8") === "deny\nkeep it in the repo\n", "No becomes deny with the note as the reason");
  check(fs.readFileSync(path.join(state, "questions", "q05678.answer"), "utf8") === "green\n", "a free-text answer goes in as typed");
  check(await until(async () => (await siteCalls()).length === 0), "and both leave the site");

  // 5. a race: answered on the site and on the boss circle at once -> no error loop, gone from both
  writeQ("q09999", { text: "Ship it tonight?" });
  check(await until(async () => (await siteCalls()).length === 1), "another call appears");
  relay.stop();
  await api("POST", "/api/calls/q09999/answer", { cookie: bryant, body: { choice: "yes" } });
  fs.writeFileSync(path.join(state, "questions", "q09999.answer"), "no\n"); // the boss circle got there first
  relay.start();
  check(await until(async () => (await siteCalls()).length === 0), "a call answered in both places leaves the site");
  check(fs.readFileSync(path.join(state, "questions", "q09999.answer"), "utf8") === "no\n", "the first answer stands");
  check(readCalls(state).length === 0, "the inbox is empty");
} finally {
  relay.stop();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
