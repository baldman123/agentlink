// Moving files through the LAN hub (contracts/uploads.md "LAN hub"): PUT before the envelope that names them is
// sent, GET by the receiving daemon before it stores that envelope. Both use the socket's REST session (protocol v2).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Attachment } from "../../contracts/index.ts";
import { UPLOAD_MAX_HUB_BYTES } from "../../contracts/index.ts";
import { UploadMismatch, UploadTooLarge } from "../../contracts/uploads-node.ts";
import { storeFile } from "./files.ts";
import type { Store } from "./store.ts";

/** A failure the hub won't change its mind about (too large, refused): the message is dropped with a note. */
export class PermanentFileError extends Error {}

const TIMEOUT_MS = 10 * 60_000;

function request(url: string, opts: http.RequestOptions): http.ClientRequest {
  return (url.startsWith("https:") ? https : http).request(url, { ...opts, timeout: TIMEOUT_MS });
}

function readAll(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (s.length < 4000 ? (s += c) : undefined));
    res.on("end", () => resolve(s));
    res.on("error", () => resolve(s));
  });
}

/** PUT one stored file to the hub. Resolves when the hub has it (201, or 200 when it already had it). */
export function putToHub(base: string, session: string, a: Attachment, to: string): Promise<void> {
  if (!a.path) return Promise.reject(new PermanentFileError(`${a.name}: no local copy`));
  const path = a.path;
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/files/${a.id}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${session}`,
        "content-type": "application/octet-stream",
        "content-length": String(a.size),
        "x-agentlink-name": encodeURIComponent(a.name),
        "x-agentlink-to": to,
        "x-agentlink-sha256": a.sha256,
        ...(a.mime ? { "x-agentlink-mime": a.mime } : {}),
      },
    });
    req.on("timeout", () => req.destroy(new Error("hub upload timed out")));
    req.on("error", reject);
    req.on("response", async (res) => {
      const text = await readAll(res);
      if (res.statusCode === 200 || res.statusCode === 201) return resolve();
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: string; detail?: string };
        detail = j.detail || j.error || detail;
      } catch {}
      const err = `hub refused ${a.name} (HTTP ${res.statusCode}): ${detail}`;
      // 401: the session ended with the socket; a reconnect gives a new one, so try again then
      if (res.statusCode === 401 || (res.statusCode ?? 500) >= 500) reject(new Error(err));
      else reject(new PermanentFileError(res.statusCode === 404 ? `${err} (this hub is too old to relay files; update it)` : err));
    });
    const src = fs.createReadStream(path);
    src.on("error", (e) => req.destroy(e));
    src.pipe(req);
  });
}

/** PUT a local file's bytes to a signed Storage URL (website mode). */
export function putToUrl(url: string, filePath: string, size: number, mime: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "PUT", headers: { "content-type": mime || "application/octet-stream", "content-length": String(size), "x-upsert": "true" } });
    req.on("timeout", () => req.destroy(new Error("storage upload timed out")));
    req.on("error", reject);
    req.on("response", async (res) => {
      const text = await readAll(res);
      if ((res.statusCode ?? 500) < 300) return resolve();
      const err = `storage refused the upload (HTTP ${res.statusCode}): ${text.slice(0, 160)}`;
      reject((res.statusCode ?? 500) >= 500 ? new Error(err) : new PermanentFileError(err));
    });
    const src = fs.createReadStream(filePath);
    src.on("error", (e) => req.destroy(e));
    src.pipe(req);
  });
}

/** GET a file from a signed Storage URL into the uploads folder, checking size and sha256 (website mode). */
export function getFromUrl(url: string, a: Attachment, store: Store, uploadsDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET" });
    req.on("timeout", () => req.destroy(new Error("storage download timed out")));
    req.on("error", reject);
    req.on("response", async (res) => {
      if (res.statusCode !== 200) {
        const text = await readAll(res);
        const msg = `storage answered ${res.statusCode} for ${a.name}: ${text.slice(0, 120)}`;
        return reject((res.statusCode ?? 500) >= 500 ? new Error(msg) : new PermanentFileError(msg));
      }
      try {
        const u = await storeFile(res, { store, uploadsDir, name: a.name, mime: a.mime, maxBytes: UPLOAD_MAX_HUB_BYTES, id: a.id, expectSize: a.size, expectSha: a.sha256 });
        resolve(u.path);
      } catch (err) {
        if (err instanceof UploadTooLarge || err instanceof UploadMismatch) reject(new PermanentFileError(`${a.name}: ${(err as Error).message}`));
        else reject(err);
      }
    });
    req.end();
  });
}

/** GET one file from the hub into this laptop's uploads folder, checking its size and sha256. */
export function getFromHub(base: string, session: string, a: Attachment, store: Store, uploadsDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/files/${a.id}`, { method: "GET", headers: { authorization: `Bearer ${session}` } });
    req.on("timeout", () => req.destroy(new Error("hub download timed out")));
    req.on("error", reject);
    req.on("response", async (res) => {
      if (res.statusCode !== 200) {
        const text = await readAll(res);
        const msg = `hub answered ${res.statusCode} for ${a.name}: ${text.slice(0, 120)}`;
        return reject(res.statusCode === 404 || res.statusCode === 410 ? new PermanentFileError(msg) : new Error(msg));
      }
      try {
        const u = await storeFile(res, {
          store,
          uploadsDir,
          name: a.name,
          mime: a.mime,
          maxBytes: UPLOAD_MAX_HUB_BYTES,
          id: a.id,
          expectSize: a.size,
          expectSha: a.sha256,
        });
        resolve(u.path);
      } catch (err) {
        if (err instanceof UploadTooLarge || err instanceof UploadMismatch) reject(new PermanentFileError(`${a.name}: ${(err as Error).message}`));
        else reject(err);
      }
    });
    req.end();
  });
}
