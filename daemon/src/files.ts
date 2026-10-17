// Files on this laptop (contracts/uploads.md): uploads from the UI or the CLI, and files downloaded from the hub.
// Everything lands in <uploadsDir>/<YYYY-MM-DD>/<sanitised name>.
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  ATTACHMENTS_MAX,
  UPLOAD_ID_RE,
  UPLOAD_MAX_HUB_BYTES,
  formatBytes,
  sanitizeFileName,
  uploadDay,
  type Attachment,
  type UploadResult,
} from "../../contracts/index.ts";
import { placeUnique, receiveFile } from "../../contracts/uploads-node.ts";
import type { Store } from "./store.ts";

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

export async function storeFile(
  src: AsyncIterable<Uint8Array>,
  o: { store: Store; uploadsDir: string; name: string; mime?: string | null; maxBytes: number; id?: string; expectSize?: number; expectSha?: string },
): Promise<UploadResult> {
  const name = sanitizeFileName(o.name);
  const dir = path.join(o.uploadsDir, uploadDay());
  const { tmp, size, sha256 } = await receiveFile(src, { dir, maxBytes: o.maxBytes, expectSize: o.expectSize, expectSha: o.expectSha });
  const final = placeUnique(tmp, dir, name);
  const result: UploadResult = {
    id: o.id ?? randomUUID(),
    name: path.basename(final),
    path: final,
    size,
    sha256,
    created_at: new Date().toISOString(),
    ...(o.mime && MIME_RE.test(o.mime) ? { mime: o.mime } : {}),
  };
  o.store.uploadInsert(result);
  return result;
}

export class AttachmentError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: string,
  ) {
    super(code);
  }
}

/**
 * Upload ids from POST /v1/send → the attachments for body.attachments. A file that will cross the hub must fit
 * UPLOAD_MAX_HUB_BYTES, and leaves without its local path (the receiving daemon sets its own).
 */
export function resolveAttachments(store: Store, ids: unknown, crossesHub: boolean): Attachment[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > ATTACHMENTS_MAX || !ids.every((x) => typeof x === "string" && UPLOAD_ID_RE.test(x)))
    throw new AttachmentError(400, "bad_attachments", `attachments must be up to ${ATTACHMENTS_MAX} upload ids`);
  if (new Set(ids).size !== ids.length) throw new AttachmentError(400, "bad_attachments", "the same file is attached twice");
  return (ids as string[]).map((id) => {
    const u = store.uploadGet(id);
    if (!u) throw new AttachmentError(404, "unknown_upload", `no uploaded file ${id} on this laptop (upload it again)`);
    if (crossesHub && u.size > UPLOAD_MAX_HUB_BYTES)
      throw new AttachmentError(413, "file_too_large", `${u.name} is ${formatBytes(u.size)}; files sent to another person can be at most ${formatBytes(UPLOAD_MAX_HUB_BYTES)}`);
    const a: Attachment = { id: u.id, name: u.name, size: u.size, sha256: u.sha256, ...(u.mime ? { mime: u.mime } : {}) };
    if (!crossesHub) a.path = u.path;
    return a;
  });
}

/** body.attachments of an envelope, when it has any. */
export function attachmentsOf(body: unknown): Attachment[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const a = (body as { attachments?: unknown }).attachments;
  return Array.isArray(a) ? (a.filter((x) => x && typeof x === "object") as Attachment[]) : [];
}

/** True when a message to `to` leaves this laptop's user (another person, or everyone). */
export const crossesHub = (to: string, user: string) => to === "*" || to.split("/")[0] !== user;
