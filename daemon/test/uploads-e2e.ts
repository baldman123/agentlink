// File uploads end to end (contracts/uploads.md) over a real LAN hub: alex (the hub owner) uploads a png, a pdf, a zip
// and a ~50 MB mp4 to his daemon and sends them to sam/orchestrator. Sam's daemon downloads them from the hub, and sam's
// bridge pastes the message into a tmux pane. Checks: every byte arrives (sha256), files land in
// <sam's data>/uploads/<date>/ with their names, the pane shows "[attached: <path>]" for each, the limits refuse what
// they should, and names can't escape the uploads folder.
//
// Everything is throwaway: its own ports (E2E_BASE, default 7850: hub, +1 alex, +2 sam), its own data folders, mDNS and
// the subnet scan off, and a private tmux server (tmux -L), so no real claude4 session or hub is ever touched.
//   Run: npx tsx test/uploads-e2e.ts   (from daemon/)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UPLOAD_MAX_HUB_BYTES, UPLOAD_MAX_LOCAL_BYTES, uploadDay, type InboxItem, type UploadResult } from "../../contracts/index.ts";

const MASTER = `uploads-e2e-${randomBytes(8).toString("hex")}`;
const BASE = Number(process.env.E2E_BASE ?? 7850);
const HUB = BASE;
const PORT = { alex: BASE + 1, sam: BASE + 2 } as const;
type User = keyof typeof PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-uploads-e2e-"));
const repo = path.resolve(import.meta.dirname, "../..");
const TSX_LOADER = pathToFileURL(path.join(repo, "node_modules/tsx/dist/loader.mjs")).href;
const SOCK = `agentlink-uploads-e2e-${process.pid}`; // private tmux server
const SESSION = "c4-uploads-e2e";
const procs: ChildProcess[] = [];
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms = 15_000, step = 150): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await sleep(step);
  }
  return undefined;
}
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8" });
const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const dataDir = (u: User) => path.join(tmp, `data-${u}`);

function run(name: string, file: string, env: Record<string, string>) {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENTLINK_") && !k.startsWith("C4_")) clean[k] = v;
  const p = spawn(process.execPath, ["--import", TSX_LOADER, file], { cwd: tmp, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const out = fs.createWriteStream(path.join(tmp, `${name}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}
function startDaemon(user: User, token: string) {
  fs.mkdirSync(dataDir(user), { recursive: true });
  return run(`daemon-${user}`, path.join(repo, "daemon/src/index.ts"), {
    AGENTLINK_USER: user,
    AGENTLINK_TOKEN: token,
    AGENTLINK_HUB_URL: `http://127.0.0.1:${HUB}`,
    AGENTLINK_DISCOVERY: "manual",
    AGENTLINK_SCAN: "0",
    AGENTLINK_DAEMON_PORT: String(PORT[user]),
    AGENTLINK_DAEMON_DB: path.join(dataDir(user), `daemon-${user}.sqlite`),
  });
}

async function api(user: User, method: string, p: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${PORT[user]}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

/** POST a file to a daemon's /v1/uploads, streamed from disk (as the UI's XHR does). */
function upload(user: User, file: string, name = path.basename(file)): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const req = http.request(`http://127.0.0.1:${PORT[user]}/v1/uploads?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null }));
    });
    fs.createReadStream(file).pipe(req);
  });
}

/** Only headers: a Content-Length over the limit must be refused before any byte is read. */
function declareOnly(user: User, bytes: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${PORT[user]}/v1/uploads?name=huge.bin`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(bytes) },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => resolve(-1));
    req.flushHeaders();
  });
}

function makeFiles() {
  const dir = path.join(tmp, "src");
  fs.mkdirSync(dir);
  // a real 1x1 PNG
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  fs.writeFileSync(path.join(dir, "screenshot 2026-10-17.png"), png);
  fs.writeFileSync(path.join(dir, "spec.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(40_000), Buffer.from("\n%%EOF\n")]));
  fs.writeFileSync(path.join(dir, "bundle.zip"), Buffer.concat([Buffer.from("PK\u0003\u0004"), randomBytes(300_000)]));
  // ~50 MB "mp4", written in pieces so the test itself stays light on memory
  const mp4 = path.join(dir, "demo.mp4");
  const fd = fs.openSync(mp4, "w");
  fs.writeSync(fd, Buffer.from("000000206674797069736f6d", "hex"));
  for (let i = 0; i < 50; i++) fs.writeSync(fd, randomBytes(1024 * 1024));
  fs.closeSync(fd);
  return ["screenshot 2026-10-17.png", "spec.pdf", "bundle.zip", "demo.mp4"].map((n) => path.join(dir, n));
}

async function main() {
  // ---------------------------------------------------------------- hub, invite, daemons
  run("hub", path.join(repo, "hub/src/index.ts"), {
    AGENTLINK_TOKEN: MASTER,
    AGENTLINK_HUB_OWNER: "alex",
    AGENTLINK_HUB_PORT: String(HUB),
    AGENTLINK_HUB_HOST: "127.0.0.1",
    AGENTLINK_HUB_DB: path.join(tmp, "hub", "hub.sqlite"),
    AGENTLINK_MDNS: "0",
  });
  fs.mkdirSync(path.join(tmp, "hub"), { recursive: true });
  check("hub starts", !!(await until(async () => (await fetch(`http://127.0.0.1:${HUB}/api/health`)).ok)));
  const inv = await fetch(`http://127.0.0.1:${HUB}/api/admin/people`, {
    method: "POST",
    headers: { authorization: `Admin ${MASTER}`, "content-type": "application/json" },
    body: JSON.stringify({ user: "sam" }),
  }).then((r) => r.json() as Promise<{ token: string }>);
  check("sam is invited", typeof inv.token === "string" && inv.token.length > 20);

  startDaemon("alex", MASTER);
  startDaemon("sam", inv.token);
  for (const u of ["alex", "sam"] as User[])
    check(`${u}'s daemon connects to the hub`, !!(await until(async () => (await api(u, "GET", "/v1/health")).body?.hub?.state === "connected")));

  // ---------------------------------------------------------------- sam's team: one tmux pane on a private server
  tmux("-f", "/dev/null", "new-session", "-d", "-s", SESSION, "-x", "400", "-y", "100", "cat");
  tmux("set", "-g", "history-limit", "20000");
  const pane = tmux("display", "-p", "-t", `${SESSION}:0.0`, "#{pane_id}").trim();
  tmux("set", "-p", "-t", pane, "@role", "orchestrator");
  const stateDir = path.join(tmp, "c4-sam");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "panes"), `0 ${pane}\n`);
  run("bridge-sam", path.join(repo, "bridge/src/index.ts"), {
    AGENTLINK_USER: "sam",
    AGENTLINK_DAEMON_PORT: String(PORT.sam),
    AGENTLINK_TOKEN: inv.token,
    C4_SESSION: SESSION,
    C4_STATE_DIR: stateDir,
    C4_TMUX_SOCKET: SOCK,
    AGENTLINK_BRIDGE_DB: path.join(dataDir("sam"), "bridge-sam.json"),
    AGENTLINK_BRIDGE_LOG: path.join(tmp, "bridge-sam.log"),
    AGENTLINK_BRIDGE_ANSWER_FALLBACK: "0",
  });
  check("sam's bridge registers the orchestrator pane", !!(await until(async () => (await api("sam", "GET", "/v1/peers")).body?.users?.find((u: any) => u.user === "sam")?.sessions?.some((s: any) => s.agent === "orchestrator"))));

  // ---------------------------------------------------------------- upload four files to alex's daemon
  const files = makeFiles();
  const ups: UploadResult[] = [];
  for (const f of files) {
    const t0 = Date.now();
    const r = await upload("alex", f);
    check(`alex uploads ${path.basename(f)} (${r.body?.size} bytes, ${Date.now() - t0} ms)`, r.status === 201 && r.body?.sha256 === sha(f), r);
    ups.push(r.body);
  }
  const alexDay = path.join(dataDir("alex"), "uploads", uploadDay());
  check("alex's copies are in <data>/uploads/<date>/ with their names", ups.every((u, i) => u.path === path.join(alexDay, path.basename(files[i])) && sha(u.path) === sha(files[i])), ups.map((u) => u.path));

  // ---------------------------------------------------------------- send to sam/orchestrator through the hub
  const sent = await api("alex", "POST", "/v1/send", { from_agent: "orchestrator", to: "sam/orchestrator", type: "task", body: "files for you", attachments: ups.map((u) => u.id) });
  check("alex sends a message with the four files to sam/orchestrator (202)", sent.status === 202, sent);
  const item = (await until(async () => (await api("sam", "GET", "/v1/inbox?agent=orchestrator")).body.messages.find((i: InboxItem) => i.envelope.id === sent.body.id), 60_000)) as InboxItem | undefined;
  check("it arrives in sam's inbox", !!item);
  const atts = (item?.envelope.body as { attachments?: UploadResult[] } | undefined)?.attachments ?? [];
  const samDay = path.join(dataDir("sam"), "uploads", uploadDay());
  for (const [i, f] of files.entries()) {
    const a = atts[i];
    check(`${path.basename(f)}: on sam's laptop under <data>/uploads/<date>/, same name`, !!a?.path && a.path === path.join(samDay, path.basename(f)), a);
    check(`${path.basename(f)}: sha256 matches the original byte for byte`, !!a?.path && fs.existsSync(a.path) && sha(a.path) === sha(f), a);
  }
  check("alex's own paths never reached sam (no /data-alex/ in the envelope)", !JSON.stringify(item?.envelope ?? {}).includes("data-alex"));

  const screen = () => tmux("capture-pane", "-p", "-J", "-S", "-5000", "-t", pane);
  const shown = await until(() => atts.length === 4 && atts.every((a) => screen().includes(`[attached: ${a.path}]`)), 20_000);
  check("sam's pane shows [attached: <full path>] for all four files", !!shown, screen().slice(-1500));
  check("...inside the untrusted fence of a remote request", /REMOTE REQUEST[\s\S]*│ {3}\[attached: /.test(screen()));

  // ---------------------------------------------------------------- own agents: no copy, the local path
  const own = await api("alex", "POST", "/v1/send", { from_agent: "human", to: "alex/worker-1", type: "chat", body: "look", attachments: [ups[0].id] });
  const ownItem = (await until(async () => (await api("alex", "GET", "/v1/inbox?agent=worker-1")).body.messages.find((i: InboxItem) => i.envelope.id === own.body?.id))) as InboxItem | undefined;
  const ownAtt = (ownItem?.envelope.body as { attachments?: UploadResult[] } | undefined)?.attachments?.[0];
  check("a file for alex's own worker keeps its local path (no download, no copy)", ownAtt?.path === ups[0].path, ownItem);

  // ---------------------------------------------------------------- limits and names
  check(`a declared Content-Length over ${UPLOAD_MAX_LOCAL_BYTES} bytes is refused with 413 before any upload`, (await declareOnly("alex", UPLOAD_MAX_LOCAL_BYTES + 1)) === 413);
  const big = path.join(tmp, "src", "big.bin");
  fs.closeSync(fs.openSync(big, "w"));
  fs.truncateSync(big, UPLOAD_MAX_HUB_BYTES + 1); // sparse: fast to make, still streams every byte
  const bigUp = await upload("alex", big);
  check("a 200 MB + 1 byte file is fine for alex's own panes (201)", bigUp.status === 201, bigUp);
  const bigSend = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "chat", body: "too big", attachments: [bigUp.body?.id] });
  check("...but sending it to sam is refused: 413 file_too_large, with the limit in the message", bigSend.status === 413 && bigSend.body?.error === "file_too_large" && /200 MB/.test(bigSend.body?.detail), bigSend);
  const own2 = await api("alex", "POST", "/v1/send", { from_agent: "human", to: "alex/orchestrator", type: "chat", body: "big but local", attachments: [bigUp.body?.id] });
  check("...and sending it to alex's own boss is allowed", own2.status === 202, own2);
  const evil = await upload("alex", files[0], "../../../etc/passwd");
  check("a name with ../ lands inside the uploads folder as 'passwd'", evil.status === 201 && evil.body.path === path.join(alexDay, "passwd"), evil.body);
  const dup = await upload("alex", files[0]);
  check("the same name again becomes '<name>-2.png', nothing is overwritten", dup.status === 201 && path.basename(dup.body.path) === "screenshot 2026-10-17-2.png", dup.body);
  const unknown = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "chat", body: "x", attachments: ["00000000-0000-4000-8000-000000000000"] });
  check("an unknown upload id is refused (404 unknown_upload)", unknown.status === 404 && unknown.body?.error === "unknown_upload", unknown);
  const del = await api("alex", "DELETE", `/v1/uploads/${dup.body.id}`);
  check("DELETE /v1/uploads/:id (the chip's ✕) removes the file", del.status === 204 && !fs.existsSync(dup.body.path));

  // ---------------------------------------------------------------- the hub's file routes
  const noAuth = await fetch(`http://127.0.0.1:${HUB}/api/files/${ups[0].id}`);
  check("the hub serves files only with a session (401 without)", noAuth.status === 401);
  check("the hub keeps relayed files only in its own folder", fs.readdirSync(path.join(tmp, "hub", "hub-files")).some((f) => f === ups[3].id));
  check("nothing is stuck in either outbox", (await api("alex", "GET", "/v1/outbox")).body.items.length === 0 && (await api("sam", "GET", "/v1/outbox")).body.items.length === 0);
}

let crashed: unknown = null;
try {
  await main();
} catch (err) {
  crashed = err;
  console.error("CRASH", err);
} finally {
  for (const p of procs.reverse()) {
    if (p.exitCode === null && p.signalCode === null) {
      const done = new Promise((r) => p.once("exit", r));
      p.kill("SIGTERM");
      await Promise.race([done, sleep(3000)]);
      if (p.exitCode === null) p.kill("SIGKILL");
    }
  }
  try {
    tmux("kill-server");
  } catch {}
}
console.log(`\n${checks - failures}/${checks} checks passed${crashed ? ", CRASHED" : ""}. Logs: ${tmp}`);
// a passing run keeps only its logs: the test files and their copies are ~500 MB
if (!failures && !crashed) for (const f of fs.readdirSync(tmp)) if (!f.endsWith(".out") && !f.endsWith(".log")) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
process.exit(failures || crashed ? 1 : 0);
