// Files relayed between daemons (contracts/uploads.md "LAN hub"). The sending daemon PUTs the bytes before the
// envelope that names them; the receiving daemon GETs them before it stores that envelope. Each file sits on disk as
// <dir>/<id> plus <id>.json (who sent it, to whom, name, size, sha256) and is deleted after HUB_FILE_TTL_MS.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ADDRESS_RE, HUB_FILE_TTL_MS, SHA256_RE, UPLOAD_ID_RE, UPLOAD_MAX_HUB_BYTES, formatBytes, sanitizeFileName } from "../../contracts/index.ts";
import { UploadMismatch, UploadTooLarge, receiveFile } from "../../contracts/uploads-node.ts";
import { logInfo } from "./log.ts";

interface FileMeta {
  id: string;
  from_user: string;
  to: string; // the envelope's target: "user/agent", "user/*" or "*"
  name: string;
  size: number;
  sha256: string;
  mime?: string;
  created_at: string;
}

const userOf = (a: string) => a.split("/")[0];
const json = (res: ServerResponse, status: number, body: unknown) =>
  void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

export class HubFiles {
  private lastSweep = 0;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private meta(id: string): FileMeta | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")) as FileMeta;
    } catch {
      return null;
    }
  }

  /** The uploader, the recipient's user, and (for "*") everyone may read a file. */
  private canRead(viewer: string, m: FileMeta): boolean {
    return viewer === m.from_user || m.to === "*" || userOf(m.to) === viewer;
  }

  async put(req: IncomingMessage, res: ServerResponse, viewer: string, id: string): Promise<void> {
    const h = req.headers;
    const size = Number(h["content-length"]);
    const sha = String(h["x-agentlink-sha256"] ?? "");
    const to = String(h["x-agentlink-to"] ?? "");
    let rawName = "";
    try {
      rawName = decodeURIComponent(String(h["x-agentlink-name"] ?? ""));
    } catch {}
    const refuse = (status: number, error: string, detail: string) => {
      req.resume(); // drain, so the client sees the answer instead of a reset
      json(res, status, { error, detail });
    };
    if (!UPLOAD_ID_RE.test(id)) return refuse(400, "bad_id", "the file id must be a uuid");
    if (!Number.isInteger(size) || size < 0) return refuse(411, "length_required", "Content-Length is required");
    if (size > UPLOAD_MAX_HUB_BYTES)
      return refuse(413, "file_too_large", `${formatBytes(size)} is over the hub's ${formatBytes(UPLOAD_MAX_HUB_BYTES)} limit per file`);
    if (!SHA256_RE.test(sha)) return refuse(400, "bad_sha256", "X-Agentlink-Sha256 must be the file's sha256 in hex");
    if (to !== "*" && !ADDRESS_RE.test(to)) return refuse(400, "bad_to", "X-Agentlink-To must be the message's target address");
    const existing = this.meta(id);
    if (existing) {
      // a retry after a lost answer; the same id from someone else is refused
      if (existing.from_user !== viewer || existing.sha256 !== sha) return refuse(409, "id_taken", "another file already has this id");
      req.resume();
      return json(res, 200, { id, size: existing.size, sha256: existing.sha256 });
    }
    try {
      const { tmp } = await receiveFile(req, { dir: this.dir, maxBytes: UPLOAD_MAX_HUB_BYTES, expectSize: size, expectSha: sha });
      fs.renameSync(tmp, path.join(this.dir, id));
    } catch (err) {
      if (err instanceof UploadTooLarge) return refuse(413, "file_too_large", `over the hub's ${formatBytes(UPLOAD_MAX_HUB_BYTES)} limit per file`);
      if (err instanceof UploadMismatch) return refuse(400, "incomplete_upload", err.message);
      throw err;
    }
    const mime = String(h["x-agentlink-mime"] ?? "");
    const m: FileMeta = {
      id,
      from_user: viewer,
      to,
      name: sanitizeFileName(rawName || "file"),
      size,
      sha256: sha,
      ...(/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? { mime } : {}),
      created_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(m), { mode: 0o600 });
    logInfo("file.stored", { id, from: viewer, to, size });
    json(res, 201, { id, size, sha256: sha });
  }

  get(res: ServerResponse, viewer: string, id: string): void {
    const m = UPLOAD_ID_RE.test(id) ? this.meta(id) : null;
    // someone else's file looks exactly like a missing one
    if (!m || !this.canRead(viewer, m) || !fs.existsSync(path.join(this.dir, id))) return json(res, 404, { error: "not_found" });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(m.size),
      "X-Agentlink-Sha256": m.sha256,
    });
    const src = fs.createReadStream(path.join(this.dir, id));
    src.on("error", () => res.destroy());
    src.pipe(res);
    logInfo("file.sent", { id, to_user: viewer, size: m.size });
  }

  /** Delete files older than the TTL and temp files from interrupted uploads. Cheap to call often; works hourly. */
  sweep(now = Date.now()): void {
    if (now - this.lastSweep < 60 * 60_000) return;
    this.lastSweep = now;
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      try {
        const age = now - fs.statSync(p).mtimeMs;
        if (age > HUB_FILE_TTL_MS || (f.endsWith(".part") && age > 24 * 60 * 60_000)) fs.rmSync(p, { force: true });
      } catch {}
    }
  }
}
