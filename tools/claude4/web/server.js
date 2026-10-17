// claude4 browser view: streams each tmux pane of a claude4 session to the page and sends
// keystrokes back. tmux stays the engine (claude4 in Terminal still works on the same
// session); this only watches and types.
//
// The page shows tmux's own copy of each pane, so it always matches what's really on screen:
// one tmux control-mode client per session ("tmux -C attach") reports which panes have new
// output, and the server then reads that pane's screen (capture-pane -e) plus any lines that
// scrolled into its history since last time. A newly connected page gets the last 3000 lines
// of history and the screen. Keystrokes go back with send-keys.
// Flow animations come from ~/.claude4/<session>/events.jsonl, which c4 appends to.
//
// Bound to 127.0.0.1 unless C4_WEB_HOST says otherwise (claude4 --web --share binds 0.0.0.0).
// Anything that can reach this server can type into the Claudes, so every route but /health
// and /join needs either the owner (a loopback request with a loopback Host and no proxy
// headers or guest cookie) or a guest cookie from an invite link in ~/.claude4/people.json.
// POSTs and the websocket must also come from this page's own origin.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { Transform, pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.C4_WEB_PORT || 7744);
const HOST = process.env.C4_WEB_HOST || "127.0.0.1";
const OWNER_NAME = process.env.C4_OWNER_NAME || "the owner";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = path.join(os.homedir(), ".claude4");
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const SESSION_RE = /^[A-Za-z0-9_-]{1,40}$/;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

// ---- people: invited guests, each with a role and a hashed token ----
const PEOPLE_FILE = path.join(STATE_ROOT, "people.json");
const ROLES = new Set(["full", "watch"]);
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
let people = [];
let peopleMtime = 0;
let saveTimer = null;

function loadPeople() {
  let st;
  try { st = fs.statSync(PEOPLE_FILE); } catch { if (people.length) { people = []; kickMissing(); } peopleMtime = 0; return; }
  if (st.mtimeMs === peopleMtime) return;
  peopleMtime = st.mtimeMs;
  try {
    const list = JSON.parse(fs.readFileSync(PEOPLE_FILE, "utf8"));
    if (Array.isArray(list)) people = list.filter((p) => p && p.id && p.tokenHash && ROLES.has(p.role));
  } catch (e) { log(`people.json unreadable: ${e.message}`); return; }
  kickMissing();
}

function savePeople() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = `${PEOPLE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(people, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, PEOPLE_FILE);
  try { peopleMtime = fs.statSync(PEOPLE_FILE).mtimeMs; } catch {}
}

// lastSeen changes on every request; write it out at most once a minute.
function touch(p) {
  p.lastSeen = Date.now();
  if (!saveTimer) saveTimer = setTimeout(() => { try { savePeople(); } catch (e) { log(`people save failed: ${e.message}`); } }, 60000);
}

const personById = (id) => people.find((p) => p.id === id);
const personByToken = (token) => { if (!token) return null; const h = sha(token); return people.find((p) => p.tokenHash === h) || null; };

const LOOPBACK_ADDR = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "cf-connecting-ip"];

function cookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

// Who is asking: {owner:true} | {person} | null. The owner check also wants a loopback Host
// (a DNS-rebinding page has its own hostname) and no proxy headers (a tunnel such as
// cloudflared running on this machine connects from loopback on a visitor's behalf).
function whoIs(req) {
  loadPeople();
  const p = personByToken(cookie(req, "c4k"));
  if (p) { touch(p); return { person: p, name: p.name, role: p.role }; }
  const local = LOOPBACK_ADDR.has(req.socket.remoteAddress) && LOOPBACK_HOST.test(req.headers.host || "")
    && !PROXY_HEADERS.some((h) => req.headers[h]);
  return local ? { owner: true, name: OWNER_NAME, role: "owner" } : null;
}

// Same-origin check: the page's own host (LAN address, https tunnel) or the loopback names.
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return false;
  if (ORIGINS.has(o)) return true;
  const host = req.headers.host || "";
  return !!host && (o === `http://${host}` || o === `https://${host}`);
}

function bases() {
  const out = [];
  if (process.env.C4_PUBLIC_URL) out.push(process.env.C4_PUBLIC_URL.replace(/\/+$/, ""));
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${PORT}`);
  return out;
}

// Every open socket, across sessions, so revoking someone can drop them at once.
const sockets = new Set();
function kickMissing() {
  for (const ws of sockets) if (ws.c4who.person && !personById(ws.c4who.person.id)) ws.close(4001, "revoked");
}

const tmux = (args) =>
  new Promise((resolve) => execFile("tmux", args, { maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : out)));

class Hub {
  constructor(name) {
    this.name = name;
    this.dir = path.join(STATE_ROOT, name);
    this.clients = new Set();
    this.slots = [];          // [{slot, pane, role, label, task, state, dir, cols, rows}]
    this.stateJson = "";
    this.inboxJson = "";
    this.eventsPos = 0;
    this.ctl = null;
    this.pending = Buffer.alloc(0);
    this.panes = new Map();   // pane id -> {hist: [lines], histSize, screen, cx, cy, cursor, cols, rows, busy, again, timer}
    try { this.eventsPos = fs.statSync(path.join(this.dir, "events.jsonl")).size; } catch {}
    this.attach();
    this.timer = setInterval(() => { this.poll(); this.tailEvents(); }, 500);
  }

  attach() {
    const ctl = spawn("tmux", ["-C", "attach", "-t", this.name], { stdio: ["pipe", "pipe", "ignore"] });
    this.ctl = ctl;
    ctl.stdout.on("data", (chunk) => this.onData(chunk));
    ctl.on("exit", () => {
      if (this.ctl !== ctl) return;
      this.ctl = null;
      this.broadcast({ t: "gone" });
      setTimeout(() => { if (this.clients.size) this.attach(); }, 2000);
    });
  }

  onData(chunk) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      this.onLine(buf.subarray(0, nl));
      buf = buf.subarray(nl + 1);
    }
    this.pending = Buffer.from(buf);
  }

  onLine(line) {
    if (line[0] !== 0x25) return; // "%"
    if (line.subarray(0, 8).toString() === "%output ") {
      const sp = line.indexOf(0x20, 8);
      if (sp === -1) return;
      this.dirty(line.subarray(8, sp).toString());
      return;
    }
    const word = line.subarray(0, line.indexOf(0x20) === -1 ? line.length : line.indexOf(0x20)).toString();
    if (word === "%layout-change" || word === "%window-add" || word === "%window-close" || word === "%unlinked-window-add") {
      clearTimeout(this.resnap);
      this.resnap = setTimeout(async () => { await this.poll(true); }, 150);
    }
  }

  async readSlots() {
    let reg = "";
    try { reg = fs.readFileSync(path.join(this.dir, "panes"), "utf8"); } catch {}
    const map = new Map(reg.split("\n").filter(Boolean).map((l) => { const [s, p] = l.trim().split(/\s+/); return [p, Number(s)]; }));
    const out = await tmux(["list-panes", "-s", "-t", this.name, "-F",
      "#{pane_id}\t#{@role}\t#{@label}\t#{@task}\t#{@state}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}"]);
    if (out === null) return null;
    return out.split("\n").filter(Boolean).map((l) => {
      const [pane, role, label, task, state, dir, cols, rows] = l.split("\t");
      return { slot: map.get(pane), pane, role, label, task, state, dir: path.basename(dir || ""), cols: +cols, rows: +rows };
    }).filter((s) => s.slot !== undefined).sort((a, b) => a.slot - b.slot);
  }

  // Autopilot (c4 autopilot on): the boss decides the owner's calls.
  autopilot() { return fs.existsSync(path.join(this.dir, "autopilot")); }

  // The owner's inbox: permission requests waiting on them, and questions the boss passed them.
  readInbox() {
    const items = [];
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
    const rdir = path.join(this.dir, "requests"), qdir = path.join(this.dir, "questions");
    for (const f of (fs.existsSync(rdir) ? fs.readdirSync(rdir) : []).filter((f) => f.endsWith(".json"))) {
      const r = read(path.join(rdir, f)), id = f.slice(0, -5);
      if (!r || !r.needsBryant || fs.existsSync(path.join(rdir, `${id}.bryant`))) continue;
      items.push({ kind: "perm", id, from: r.slot, summary: r.summary || "", detail: r.detail || r.what, what: r.what, why: r.why, t: r.t });
    }
    for (const f of (fs.existsSync(qdir) ? fs.readdirSync(qdir) : []).filter((f) => f.endsWith(".json"))) {
      const q = read(path.join(qdir, f)), id = f.slice(0, -5);
      if (!q || fs.existsSync(path.join(qdir, `${id}.answer`))) continue;
      items.push({ kind: "question", id, from: q.from, summary: q.summary || q.text, detail: q.summary ? q.detail || "" : "", what: q.text, t: q.t });
    }
    return items.sort((a, b) => a.t - b.t);
  }

  async poll(forceSnap = false) {
    const inbox = this.readInbox(), autopilot = this.autopilot(), inboxJson = JSON.stringify([inbox, autopilot]);
    if (inboxJson !== this.inboxJson) { this.inboxJson = inboxJson; this.broadcast({ t: "inbox", items: inbox, autopilot }); }
    const slots = await this.readSlots();
    if (slots === null) { this.broadcast({ t: "gone" }); return; }
    const before = new Map(this.slots.map((s) => [s.pane, s]));
    this.slots = slots;
    const json = JSON.stringify(slots);
    if (json !== this.stateJson) {
      this.stateJson = json;
      this.broadcast({ t: "state", slots });
    }
    for (const s of slots) {
      const old = before.get(s.pane);
      if (forceSnap || !old || old.cols !== s.cols || old.rows !== s.rows) this.dirty(s.pane, true);
    }
  }

  // Coalesce bursts of output: read a pane at most every 60ms, never two reads at once.
  dirty(pane, now = false) {
    let st = this.panes.get(pane);
    if (!st) { st = { hist: [], histSize: -1, screen: [], cx: 0, cy: 0, cursor: 1, cols: 80, rows: 24, busy: false, again: false, timer: null }; this.panes.set(pane, st); }
    if (st.busy) { st.again = true; return; }
    if (st.timer && !now) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => { st.timer = null; this.refresh(pane, st); }, now ? 0 : 100);
  }

  async refresh(pane, st) {
    const slot = this.slots.find((s) => s.pane === pane);
    if (!slot) return;
    st.busy = true;
    try {
      const SEP = "@@c4-screen-below@@";
      const out = await tmux(["display", "-p", "-t", pane, "#{history_size} #{cursor_x} #{cursor_y} #{cursor_flag} #{pane_width} #{pane_height}", ";",
        "display", "-p", SEP, ";", "capture-pane", "-p", "-e", "-t", pane]);
      if (out === null) return;
      const cut = out.indexOf(SEP);
      const [hs, cx, cy, cursor, cols, rows] = out.slice(0, cut).trim().split(" ").map(Number);
      const screen = out.slice(cut + SEP.length + 1).replace(/\n$/, "").split("\n");
      const lines = (from) => tmux(["capture-pane", "-p", "-e", "-S", String(-from), "-E", "-1", "-t", pane])
        .then((o) => (o === null ? [] : o.replace(/\n$/, "").split("\n")));
      let reset = false, added = [];
      if (st.histSize < 0 || hs < st.histSize || hs - st.histSize > 3000) {
        st.hist = hs > 0 ? await lines(Math.min(hs, 3000)) : [];
        reset = true;
      } else if (hs > st.histSize) {
        added = await lines(hs - st.histSize);
        st.hist.push(...added);
        if (st.hist.length > 3000) st.hist.splice(0, st.hist.length - 3000);
      }
      // Send only the screen lines that changed (Claude's spinner changes one line many times a second).
      const prev = st.screen;
      const patch = [];
      for (let i = 0; i < screen.length; i++) if (screen[i] !== prev[i]) patch.push([i, screen[i]]);
      const same = !reset && !added.length && !patch.length && screen.length === prev.length && cx === st.cx && cy === st.cy && cursor === st.cursor;
      const full = reset || st.histSize < 0 || patch.length > screen.length * 0.6;
      Object.assign(st, { histSize: hs, screen, cx, cy, cursor, cols, rows });
      if (same) return;
      const msg = this.screenMsg(slot.slot, st, reset ? st.hist : added, reset);
      if (!full) { delete msg.screen; msg.patch = patch; msg.len = screen.length; }
      this.broadcast(msg);
    } finally {
      st.busy = false;
      if (st.again) { st.again = false; this.dirty(pane); }
    }
  }

  screenMsg(slot, st, hist, reset) {
    return { t: "screen", slot, cols: st.cols, rows: st.rows, cx: st.cx, cy: st.cy, cursor: st.cursor, screen: st.screen, hist, reset };
  }

  tailEvents() {
    const file = path.join(this.dir, "events.jsonl");
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < this.eventsPos) this.eventsPos = 0;
    if (size === this.eventsPos) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - this.eventsPos);
    fs.readSync(fd, buf, 0, buf.length, this.eventsPos);
    fs.closeSync(fd);
    this.eventsPos = size;
    for (const line of buf.toString().split("\n")) {
      if (!line.trim()) continue;
      try { this.broadcast({ t: "event", ...JSON.parse(line) }); } catch {}
    }
  }

  input(slot, b64) {
    const s = this.slots.find((x) => x.slot === slot);
    if (!s || !this.ctl) return;
    const bytes = Buffer.from(b64, "base64");
    for (let i = 0; i < bytes.length; i += 256) {
      const hex = [...bytes.subarray(i, i + 256)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      this.ctl.stdin.write(`send-keys -t ${s.pane} -H ${hex}\n`);
    }
  }

  async join(ws) {
    this.clients.add(ws);
    this.presence();
    if (!this.ctl) this.attach();
    await this.poll();
    ws.send(JSON.stringify({ t: "state", slots: this.slots }));
    ws.send(JSON.stringify({ t: "inbox", items: this.readInbox(), autopilot: this.autopilot() }));
    for (const s of this.slots) {
      const st = this.panes.get(s.pane);
      if (st && st.histSize >= 0) ws.send(JSON.stringify(this.screenMsg(s.slot, st, st.hist, true)));
      else this.dirty(s.pane, true);
    }
  }

  leave(ws) {
    this.clients.delete(ws);
    this.presence();
  }

  presence() {
    const seen = new Map();
    for (const ws of this.clients) {
      const w = ws.c4who;
      const p = w.owner ? null : personById(w.person.id);
      if (!w.owner && !p) continue;
      const key = w.owner ? "owner" : p.id;
      if (!seen.has(key)) seen.set(key, { name: w.owner ? OWNER_NAME : p.name, role: w.owner ? "owner" : p.role });
    }
    this.broadcast({ t: "people", online: [...seen.values()] });
  }

  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(text);
  }
}

const hubs = new Map();
const hubFor = (name) => {
  if (!hubs.has(name)) hubs.set(name, new Hub(name));
  return hubs.get(name);
};

const page = (res, code, text) => {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>claude4</title>
<body style="font:16px system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh;margin:0;padding:0 16px"><p>${text}</p>`);
};
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const readBody = (req, cb) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on("end", () => { let m; try { m = JSON.parse(body || "{}"); } catch { m = null; } cb(m, body); });
};
const online = (id) => [...sockets].some((ws) => ws.c4who.person?.id === id);

// ---- uploads: files dropped, pasted or picked on the page ----
// Each one is streamed to ~/.claude4/<session>/uploads/<yyyymmdd-hhmmss>-<name>, then its path is pasted
// (bracketed, no Enter) into the pane's input, so the person can keep typing around it.
const UPLOAD_MAX = Number(process.env.C4_UPLOAD_MAX || 2 * 1024 ** 3);
// The last path segment only, no control characters, no leading dots (so no "." or ".."), extension kept.
function safeName(raw) {
  let n = String(raw || "").normalize("NFC").split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").replace(/[<>:"|?*`]/g, "_").trim();
  n = n.replace(/^\.+/, "").trim() || "file";
  const dot = n.lastIndexOf(".");
  const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
  let base = ext ? n.slice(0, dot) : n;
  while (Buffer.byteLength(base + ext) > 150) base = base.slice(0, -1);
  return (base || "file") + ext;
}
const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
// The tmux pane for a slot, from the session's registry, if it's still there.
async function paneOf(session, slot) {
  let reg = "";
  try { reg = fs.readFileSync(path.join(STATE_ROOT, session, "panes"), "utf8"); } catch { return null; }
  const hit = reg.split("\n").map((l) => l.trim().split(/\s+/)).find(([s]) => s !== "" && Number(s) === slot);
  if (!hit || !/^%\d+$/.test(hit[1] || "")) return null;
  return (await tmux(["display", "-p", "-t", hit[1], "#{pane_id}"]))?.trim() === hit[1] ? hit[1] : null;
}
// Bracketed paste (only if the app asked for it, as Claude Code does), without Enter.
async function pasteInto(pane, text) {
  const buf = `c4up-${crypto.randomBytes(4).toString("hex")}`;
  if ((await tmux(["set-buffer", "-b", buf, "--", text])) === null) return false;
  return (await tmux(["paste-buffer", "-p", "-d", "-b", buf, "-t", pane])) !== null;
}
const quotePath = (p) => (/[\s"'\\]/.test(p) ? `"${p.replace(/(["\\])/g, "\\$1")}"` : p);

async function upload(req, res, url, who, session) {
  const refuse = (code, error) => { res.setHeader("connection", "close"); json(res, code, { ok: false, error }); req.resume(); };
  // Same rule as typing: the owner and people who can type; read the role live.
  const role = who.owner ? "owner" : personById(who.person.id)?.role;
  if (role !== "owner" && role !== "full") return refuse(403, "Watch only: you can't send files.");
  const slot = Number(url.searchParams.get("slot"));
  if (!SESSION_RE.test(session) || !Number.isInteger(slot) || slot < 0 || slot > 9) return refuse(400, "bad session or slot");
  const len = Number(req.headers["content-length"]);
  if (len > UPLOAD_MAX) return refuse(413, `Too big: the limit is ${UPLOAD_MAX >= 1024 ** 3 ? `${+(UPLOAD_MAX / 1024 ** 3).toFixed(1)} GB` : `${Math.round(UPLOAD_MAX / 1024 ** 2)} MB`}.`);
  const pane = await paneOf(session, slot);
  if (!pane) return refuse(404, "That pane isn't running.");
  const dir = path.join(STATE_ROOT, session, "uploads");
  const name = safeName(url.searchParams.get("name"));
  let file, fd;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 1; !fd; i++) {
      file = path.join(dir, `${stamp()}-${i > 1 ? `${i}-` : ""}${name}`);
      try { fd = fs.openSync(file, "wx", 0o600); } catch (e) { if (e.code !== "EEXIST" || i > 50) throw e; }
    }
  } catch (e) { log(`upload failed: ${e.message}`); return refuse(500, "Couldn't save the file."); }
  let size = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      cb(size > UPLOAD_MAX ? Object.assign(new Error("too big"), { code: "TOO_BIG" }) : null, chunk);
    },
  });
  pipeline(req, count, fs.createWriteStream(null, { fd }), async (err) => {
    if (err) {
      fs.rm(file, { force: true }, () => {});
      log(`upload aborted session=${session} slot=${slot} name=${JSON.stringify(name)} after ${size}B: ${err.code || err.message}`);
      if (!res.headersSent && !res.destroyed) json(res, err.code === "TOO_BIG" ? 413 : 400, { ok: false, error: err.code === "TOO_BIG" ? "Too big." : "The upload didn't finish." });
      return;
    }
    const pasted = await pasteInto(pane, `[attached: ${quotePath(file)}] `);
    log(`upload session=${session} slot=${slot} name=${JSON.stringify(who.name)} file=${JSON.stringify(path.basename(file))} ${size}B pasted=${pasted}`);
    json(res, 200, { ok: true, path: file, size, pasted });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/health") return res.end("ok");

  if (url.pathname === "/join" && req.method === "GET") {
    loadPeople();
    const token = url.searchParams.get("k") || "";
    const p = personByToken(token);
    if (!p) { log(`join refused: bad or revoked invite from ${req.socket.remoteAddress}`); return page(res, 403, `This invite link isn't valid any more. Ask ${OWNER_NAME} for a new one.`); }
    touch(p);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    log(`join name=${JSON.stringify(p.name)} role=${p.role} from ${req.socket.remoteAddress}`);
    const s = url.searchParams.get("s") || "";
    res.writeHead(302, { location: SESSION_RE.test(s) ? `/?s=${s}` : "/", "set-cookie": `c4k=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${secure}`, "cache-control": "no-store" });
    return res.end();
  }

  const who = whoIs(req);
  if (!who) {
    if (url.pathname === "/" && req.method === "GET") return page(res, 401, `You need an invite link to see this. Ask ${OWNER_NAME} for one.`);
    res.writeHead(401); return res.end();
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return fs.createReadStream(path.join(HERE, "index.html")).pipe(res);
  }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }

  const session = url.searchParams.get("s") || url.searchParams.get("session") || "";
  // Every guest call and every POST; the owner's own page polls GETs, which would flood the log.
  if (!who.owner || req.method !== "GET") log(`api ${req.method} ${url.pathname} name=${JSON.stringify(who.name)} role=${who.role}${session ? ` session=${session}` : ""}`);
  if (req.method === "POST" && !originOk(req)) { res.writeHead(403); return res.end(); }

  if (url.pathname === "/api/me" && req.method === "GET") return json(res, 200, { name: who.name, role: who.role, owner: !!who.owner });
  if (url.pathname === "/api/upload" && req.method === "POST") return void upload(req, res, url, who, session);

  if (url.pathname.startsWith("/api/people")) {
    if (!who.owner) { res.writeHead(403); return res.end(); }
    if (url.pathname === "/api/people" && req.method === "GET") {
      return json(res, 200, {
        people: people.map((p) => ({ id: p.id, name: p.name, role: p.role, created: p.created, lastSeen: p.lastSeen ?? null, online: online(p.id) })),
        bases: bases(),
        host: HOST,
      });
    }
    if (req.method !== "POST") { res.writeHead(404); return res.end(); }
    return readBody(req, (m) => {
      if (!m) return json(res, 400, { error: "bad json" });
      if (url.pathname === "/api/people") {
        const name = String(m.name || "").trim().replace(/[\x00-\x1f]/g, "").slice(0, 40);
        const role = String(m.role || "watch");
        if (!name || !ROLES.has(role)) return json(res, 400, { error: "need a name and role full|watch" });
        const token = crypto.randomBytes(32).toString("base64url");
        const p = { id: crypto.randomBytes(6).toString("hex"), name, role, tokenHash: sha(token), created: Date.now(), lastSeen: null };
        people.push(p); savePeople();
        log(`people add id=${p.id} name=${JSON.stringify(name)} role=${role}`);
        const base = bases()[0] || `http://127.0.0.1:${PORT}`;
        return json(res, 200, { id: p.id, token, link: `${base}/join?k=${token}${SESSION_RE.test(session) ? `&s=${session}` : ""}` });
      }
      const p = personById(String(m.id || ""));
      if (!p) return json(res, 404, { error: "no such person" });
      if (url.pathname === "/api/people/revoke") {
        people = people.filter((x) => x !== p); savePeople(); kickMissing();
        log(`people revoke id=${p.id} name=${JSON.stringify(p.name)}`);
        for (const h of hubs.values()) h.presence();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/people/role") {
        if (!ROLES.has(m.role)) return json(res, 400, { error: "role must be full|watch" });
        p.role = m.role; savePeople();
        log(`people role id=${p.id} name=${JSON.stringify(p.name)} role=${p.role}`);
        for (const h of hubs.values()) h.presence();
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "unknown" });
    });
  }

  if ((url.pathname === "/api/decide" || url.pathname === "/api/answer") && req.method === "POST") {
    if (!who.owner || !SESSION_RE.test(session)) { res.writeHead(403); return res.end(); }
    readBody(req, (m, body) => {
      if (!m) { res.writeHead(400); return res.end(); }
      const id = String(m.id || "");
      if (!/^[A-Za-z0-9]{2,20}$/.test(id)) { res.writeHead(400); return res.end(); }
      log(`${url.pathname} session=${session} id=${id} body=${body.slice(0, 120)}`);
      const args = url.pathname === "/api/decide"
        ? ["decide", id, m.verdict === "approve" ? "approve" : "deny", String(m.reason || "")]
        : ["answer", id, String(m.text || "")];
      execFile("c4", args.filter((a, i) => i < 3 || a), { env: { ...process.env, C4_SESSION: session, TMUX_PANE: "" } }, (err, out, errOut) => {
        json(res, err ? 500 : 200, { ok: !err, message: (out || errOut || "").trim() });
        hubs.get(session)?.poll();
      });
    });
    return;
  }
  if (url.pathname === "/api/autopilot" && req.method === "POST") {
    if (!who.owner || !SESSION_RE.test(session)) { res.writeHead(403); return res.end(); }
    readBody(req, (m) => {
      if (!m) { res.writeHead(400); return res.end(); }
      log(`/api/autopilot session=${session} on=${!!m.on}`);
      execFile("c4", ["autopilot", m.on ? "on" : "off"], { env: { ...process.env, C4_SESSION: session, TMUX_PANE: "" } }, (err, out, errOut) => {
        json(res, err ? 500 : 200, { ok: !err, message: (out || errOut || "").trim() });
        hubs.get(session)?.poll();
      });
    });
    return;
  }
  if (url.pathname === "/api/boss" && req.method === "POST") {
    if (who.role === "watch" || !SESSION_RE.test(session)) { res.writeHead(403); return res.end(); }
    execFile("c4", ["summon-boss"], { env: { ...process.env, C4_SESSION: session } }, (err, out, errOut) => {
      json(res, err ? 500 : 200, { ok: !err, message: (out || errOut || "").trim() });
      hubs.get(session)?.poll(true);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const session = url.searchParams.get("s") || "";
  if (url.pathname !== "/ws" || !originOk(req) || !SESSION_RE.test(session)) {
    socket.destroy();
    return;
  }
  const who = whoIs(req);
  if (!who) {
    log(`ws refused: no invite, session=${session} from ${req.socket.remoteAddress}`);
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  log(`page joined session=${session} name=${JSON.stringify(who.name)} role=${who.role} from ${req.socket.remoteAddress}`);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.c4who = who;
    sockets.add(ws);
    const hub = hubFor(session);
    hub.join(ws);
    // Typed input is logged per person at most every 5s, as a byte count per slot.
    let typed = new Map(), logTimer = null;
    const flush = () => {
      logTimer = null;
      if (!typed.size) return;
      log(`input session=${session} name=${JSON.stringify(who.name)} ${[...typed].map(([s, n]) => `slot${s}=${n}B`).join(" ")}`);
      typed = new Map();
    };
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t !== "in" || !Number.isInteger(msg.slot) || typeof msg.d !== "string") return;
      // Read the role live, so a role change applies without reconnecting.
      const role = who.owner ? "owner" : personById(who.person.id)?.role;
      if (role !== "owner" && role !== "full") return;
      hub.input(msg.slot, msg.d);
      typed.set(msg.slot, (typed.get(msg.slot) || 0) + Math.floor(msg.d.length * 3 / 4));
      if (!logTimer) logTimer = setTimeout(flush, 5000);
    });
    ws.on("close", () => { clearTimeout(logTimer); flush(); sockets.delete(ws); hub.leave(ws); });
  });
});

loadPeople();
// Pick up edits made outside the server (e.g. the launcher), and kick anyone removed there.
setInterval(loadPeople, 2000);
server.listen(PORT, HOST, () => log(`claude4 web view on http://${HOST}:${PORT}`));
