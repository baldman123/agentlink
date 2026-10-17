// Files through the website (contracts/uploads.md "Website"). The API only reserves, checks and signs: the bytes go
// from the sender to Storage and from Storage to the reader with signed URLs, so Vercel's request size limits never
// apply. A file is readable by its uploader and by everyone a message naming it was sent to.
import {
  ATTACHMENTS_MAX,
  HUB_FILE_TTL_MS,
  SHA256_RE,
  UPLOAD_ID_RE,
  UPLOAD_MAX_HUB_BYTES,
  formatBytes,
  sanitizeFileName,
  type Attachment,
  type CloudFileCreate,
  type CloudFileCreated,
  type CloudFileDownload,
  type Envelope,
} from "../../../contracts/index.ts";
import type { Deps } from "./deps.ts";
import { ConfigError } from "./env.ts";
import { HttpError, log } from "./http.ts";
import type { FileRow, FileStorage } from "./store.ts";

export const DOWNLOAD_URL_SECONDS = 10 * 60;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
const userOf = (a: string) => a.split("/")[0];

function storage(d: Deps): FileStorage {
  if (!d.files) throw new ConfigError("file storage is not configured");
  return d.files;
}

const live = (f: FileRow, now: number) => Date.parse(f.expires_at) > now;
export const canRead = (f: FileRow, user: string) => f.uploader === user || f.recipients.includes(user) || f.recipients.includes("*");

/** POST /api/files: check the limits, reserve the row, hand back a signed upload URL. Also sweeps a few expired files. */
export async function createUpload(d: Deps, user: string, b: Partial<CloudFileCreate>): Promise<CloudFileCreated> {
  const files = storage(d);
  if (typeof b.name !== "string" || !b.name.trim()) throw new HttpError(400, "bad_name", "name is required");
  if (!Number.isInteger(b.size) || (b.size as number) < 0) throw new HttpError(400, "bad_size", "size must be the file's length in bytes");
  if ((b.size as number) > UPLOAD_MAX_HUB_BYTES)
    throw new HttpError(413, "file_too_large", `${formatBytes(b.size as number)} is over the ${formatBytes(UPLOAD_MAX_HUB_BYTES)} limit per file`);
  if (typeof b.sha256 !== "string" || !SHA256_RE.test(b.sha256)) throw new HttpError(400, "bad_sha256", "sha256 must be 64 hex characters");
  if (b.mime !== undefined && (typeof b.mime !== "string" || (b.mime !== "" && !MIME_RE.test(b.mime)))) throw new HttpError(400, "bad_mime");
  if (b.id !== undefined && (typeof b.id !== "string" || !UPLOAD_ID_RE.test(b.id))) throw new HttpError(400, "bad_id", "id must be a lowercase uuid");

  await cleanupExpired(d, 20).catch((err) => log("files.cleanup_failed", { error: String(err) }));

  const id = b.id ?? crypto.randomUUID();
  const now = d.now();
  const existing = await d.store.getFile(id);
  if (existing) {
    // a retry from the same sender for the same bytes: same row, a fresh URL if it isn't finished
    if (existing.uploader !== user || existing.sha256 !== b.sha256 || existing.size !== b.size || !live(existing, now))
      throw new HttpError(409, "id_taken", "another file already has this id");
    return {
      id,
      name: existing.name,
      upload_url: existing.uploaded_at ? null : await files.signedUploadUrl(existing.storage_path),
      expires_at: existing.expires_at,
    };
  }
  const row: FileRow = {
    id,
    uploader: user,
    recipients: [],
    name: sanitizeFileName(b.name),
    size: b.size as number,
    sha256: b.sha256,
    mime: b.mime && MIME_RE.test(b.mime) ? b.mime : null,
    storage_path: `${user}/${id}`,
    created_at: new Date(now).toISOString(),
    uploaded_at: null,
    expires_at: new Date(now + HUB_FILE_TTL_MS).toISOString(),
  };
  if (!(await d.store.createFile(row))) throw new HttpError(409, "id_taken", "another file already has this id");
  log("file.reserved", { id, user, size: row.size });
  return { id, name: row.name, upload_url: await files.signedUploadUrl(row.storage_path), expires_at: row.expires_at };
}

/** POST /api/files/:id/complete: the sender says the PUT finished; Storage must hold exactly `size` bytes. */
export async function completeUpload(d: Deps, user: string, id: string): Promise<{ id: string; size: number }> {
  const files = storage(d);
  const f = UPLOAD_ID_RE.test(id) ? await d.store.getFile(id) : null;
  if (!f || f.uploader !== user) throw new HttpError(404, "not_found");
  if (f.uploaded_at) return { id, size: f.size };
  const got = await files.size(f.storage_path);
  if (got === null) throw new HttpError(409, "not_uploaded", "Storage has no bytes for this file yet; PUT them to the upload URL first");
  if (got !== f.size) {
    await files.remove([f.storage_path]).catch(() => {});
    throw new HttpError(400, "incomplete_upload", `Storage holds ${got} bytes, expected ${f.size}; upload it again`);
  }
  await d.store.markFileUploaded(id, new Date(d.now()).toISOString());
  log("file.uploaded", { id, user, size: f.size });
  return { id, size: f.size };
}

/** GET /api/files/:id: a short-lived download URL, for the uploader and the recipients only. */
export async function downloadFor(d: Deps, user: string, id: string): Promise<CloudFileDownload> {
  const files = storage(d);
  const f = UPLOAD_ID_RE.test(id) ? await d.store.getFile(id) : null;
  // someone else's file looks exactly like a missing one
  if (!f || !canRead(f, user)) throw new HttpError(404, "not_found");
  if (!live(f, d.now())) throw new HttpError(410, "expired", "files are kept for 7 days");
  if (!f.uploaded_at) throw new HttpError(409, "not_uploaded", "the sender hasn't finished uploading it");
  log("file.download", { id, user, uploader: f.uploader });
  return {
    id,
    name: f.name,
    size: f.size,
    sha256: f.sha256,
    ...(f.mime ? { mime: f.mime } : {}),
    url: await files.signedDownloadUrl(f.storage_path, DOWNLOAD_URL_SECONDS),
    expires_at: f.expires_at,
  };
}

/** Deletes up to `limit` expired files, bytes first. Returns how many went. */
export async function cleanupExpired(d: Deps, limit = 200): Promise<number> {
  const files = storage(d);
  const old = await d.store.expiredFiles(new Date(d.now()).toISOString(), limit);
  if (!old.length) return 0;
  await files.remove(old.map((f) => f.storage_path));
  await d.store.deleteFiles(old.map((f) => f.id));
  log("files.cleaned", { count: old.length });
  return old.length;
}

/**
 * For POST /api/messages. A message to someone else may only name files its sender uploaded through the website and
 * finished; their attachments are rewritten from the rows (the server's name, size and sha256, never a path). Files for
 * the sender's own agents are on their own laptop and pass as they are. Returns the envelope to store and the file ids
 * whose readers to extend, or why it is refused.
 */
export async function checkAttachments(d: Deps, caller: string, env: Envelope): Promise<{ env: Envelope; fileIds: string[] } | { refused: string }> {
  const body = env.body;
  if (typeof body === "string" || !body || !("attachments" in body) || body.attachments === undefined) return { env, fileIds: [] };
  const atts = body.attachments as unknown;
  if (!Array.isArray(atts) || atts.length > ATTACHMENTS_MAX) return { refused: "bad_attachment" };
  const crosses = env.to === "*" || userOf(env.to) !== caller;
  if (!crosses || !atts.length) return { env, fileIds: [] };
  const now = d.now();
  const out: Attachment[] = [];
  for (const a of atts as Partial<Attachment>[]) {
    const f = typeof a?.id === "string" && UPLOAD_ID_RE.test(a.id) ? await d.store.getFile(a.id) : null;
    if (!f || f.uploader !== caller || !f.uploaded_at || !live(f, now)) return { refused: "bad_attachment" };
    out.push({ id: f.id, name: f.name, size: f.size, sha256: f.sha256, ...(f.mime ? { mime: f.mime } : {}) });
  }
  return { env: { ...env, body: { ...body, attachments: out } }, fileIds: out.map((a) => a.id) };
}
