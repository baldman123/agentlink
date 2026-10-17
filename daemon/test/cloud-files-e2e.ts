// Files through the website (contracts/uploads.md "Website"), end to end: alex and sam run real daemons in cloud
// mode against local-cloud.ts (the real cloud/app/api routes on an in-memory store, with in-memory Storage served at
// the signed URLs). Alex uploads a png and a ~5 MB mp4 to his daemon and sends them to sam/orchestrator; sam's daemon
// fetches them through GET /api/files/:id and the signed URL, checks size and sha256, and stores them in its uploads
// folder. Also: sam can't read a file not sent to him, and a message can't name someone else's file.
//   Run: npx tsx test/cloud-files-e2e.ts   (from daemon/; ports 7781 and 7782)
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { uploadDay, type InboxItem, type UploadResult } from "../../contracts/index.ts";
import { MASTER_CODE, startLocalCloud, type LocalCloud } from "./local-cloud.ts";

const PORT = { alex: 7781, sam: 7782 } as const;
type User = keyof typeof PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cloud-files-"));
const daemonDir = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = pathToFileURL(path.resolve(daemonDir, "../node_modules/tsx/dist/loader.mjs")).href;
const procs: ChildProcess[] = [];
let failures = 0;
let checks = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, ms = 20_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  return undefined;
}
const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const api = async (u: User, method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT[u]}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
function upload(u: User, file: string): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT[u]}/v1/uploads?name=${encodeURIComponent(path.basename(file))}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(fs.statSync(file).size) },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => resolve(JSON.parse(s)));
    });
    fs.createReadStream(file).pipe(req);
  });
}

let cloud!: LocalCloud;
function startDaemon(u: User, code: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("AGENTLINK_") && !k.startsWith("C4_")) env[k] = v;
  fs.mkdirSync(path.join(tmp, `data-${u}`), { recursive: true });
  const p = spawn(process.execPath, ["--import", TSX_LOADER, path.join(daemonDir, "src/index.ts")], {
    cwd: tmp,
    env: {
      ...env,
      AGENTLINK_USER: u,
      AGENTLINK_TOKEN: code,
      AGENTLINK_HUB_URL: cloud.url,
      AGENTLINK_HUB_MODE: "cloud",
      AGENTLINK_DAEMON_PORT: String(PORT[u]),
      AGENTLINK_DAEMON_DB: path.join(tmp, `data-${u}`, `daemon-${u}.sqlite`),
      AGENTLINK_USAGE: "0",
      AGENTLINK_CALLS: "0",
      C4_STATE_DIR: path.join(tmp, `c4-${u}`),
      C4_SESSION: `c4-cloudfiles-${u}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = fs.createWriteStream(path.join(tmp, `daemon-${u}.out`), { flags: "a" });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
}

async function main() {
  cloud = await startLocalCloud({ owner: "alex" });
  const samCode = await cloud.invite("sam");
  startDaemon("alex", MASTER_CODE);
  startDaemon("sam", samCode);
  for (const u of ["alex", "sam"] as User[]) check(`${u}'s daemon connects to the website`, !!(await until(async () => (await api(u, "GET", "/v1/health")).body?.hub?.state === "connected")));
  await api("sam", "PUT", "/v1/sessions/orchestrator", { kind: "orchestrator", status: "idle", task: "" });

  const src = path.join(tmp, "src");
  fs.mkdirSync(src);
  const png = path.join(src, "shot.png");
  fs.writeFileSync(png, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(5_000)]));
  const mp4 = path.join(src, "demo.mp4");
  fs.writeFileSync(mp4, randomBytes(5 * 1024 * 1024));
  const ups = [await upload("alex", png), await upload("alex", mp4)];
  check("alex uploads two files to his daemon", ups.every((u) => typeof u.id === "string" && u.size > 0), ups);

  const sent = await api("alex", "POST", "/v1/send", { to: "sam/orchestrator", type: "task", body: "files via the website", attachments: ups.map((u) => u.id) });
  check("alex sends them to sam/orchestrator (202)", sent.status === 202, sent);
  check("alex's outbox drains (files reserved, uploaded, completed; message accepted)", !!(await until(async () => (await api("alex", "GET", "/v1/outbox")).body.items.length === 0)), (await api("alex", "GET", "/v1/outbox")).body);
  check("the website holds both files in Storage", ups.every((u) => cloud.files.objects.get(`alex/${u.id}`)?.length === u.size));
  const row = await cloud.store.getFile(ups[0].id);
  check("the file rows: uploader alex, recipients [sam], uploaded", row?.uploader === "alex" && JSON.stringify(row?.recipients) === '["sam"]' && !!row?.uploaded_at, row);

  const item = (await until(async () => (await api("sam", "GET", "/v1/inbox?agent=orchestrator")).body.messages.find((i: InboxItem) => i.envelope.id === sent.body.id))) as InboxItem | undefined;
  check("the message reaches sam", !!item);
  const atts = ((item?.envelope.body as { attachments?: UploadResult[] }) ?? {}).attachments ?? [];
  const day = path.join(tmp, "data-sam", "uploads", uploadDay());
  for (const [i, f] of [png, mp4].entries()) {
    check(`${path.basename(f)}: in sam's uploads/<date>/ with its name`, atts[i]?.path === path.join(day, path.basename(f)), atts[i]);
    check(`${path.basename(f)}: sha256 matches byte for byte`, !!atts[i]?.path && sha(atts[i].path!) === sha(f));
  }

  // access rules, straight against the API
  const login = async (code: string, user?: string) =>
    ((await (await fetch(cloud.url + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(user ? { code, user } : { code }) })).json()) as { session: string }).session;
  const leeCode = await cloud.invite("lee");
  const lee = await login(leeCode, "lee");
  const get = await fetch(`${cloud.url}/api/files/${ups[0].id}`, { headers: { authorization: `Bearer ${lee}` } });
  check("lee (not a recipient) gets 404 for alex's file", get.status === 404);
  const steal = await fetch(`${cloud.url}/api/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${lee}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "sam/orchestrator", type: "chat", body: { text: "x", attachments: [{ id: ups[0].id, name: "x", size: 1, sha256: "0".repeat(64) }] } }),
  });
  check("lee can't attach alex's file to his own message (422 bad_attachment)", steal.status === 422 && (await steal.json()).reason === "bad_attachment");
}

let crashed: unknown = null;
try {
  await main();
} catch (err) {
  crashed = err;
  console.error("CRASH", err);
} finally {
  for (const p of procs) {
    if (p.exitCode === null) {
      p.kill("SIGTERM");
      await Promise.race([new Promise((r) => p.once("exit", r)), sleep(3000)]);
    }
  }
  await cloud?.close();
}
console.log(`\n${checks - failures}/${checks} checks passed${crashed ? ", CRASHED" : ""}. Logs: ${tmp}`);
process.exit(failures || crashed ? 1 : 0);
