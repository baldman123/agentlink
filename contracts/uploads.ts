// File uploads (contracts/uploads.md). Shared by the daemon, the hub, the bridge and the UI, so it imports nothing
// from node: the UI bundles it too.

/** One file sent to this laptop's own panes or agents (the daemon streams it to disk). */
export const UPLOAD_MAX_LOCAL_BYTES = 2 * 1024 ** 3; // 2 GB
/** One file that has to cross the hub to reach another person's laptop. */
export const UPLOAD_MAX_HUB_BYTES = 200 * 1024 ** 2; // 200 MB
/** How long the LAN hub keeps a relayed file before deleting it. */
export const HUB_FILE_TTL_MS = 7 * 24 * 60 * 60_000;
/** A message carries at most this many files. */
export const ATTACHMENTS_MAX = 20;
/** Longest stored file name, in UTF-8 bytes (APFS allows 255; the room left over is for "-2" and friends). */
export const UPLOAD_NAME_MAX_BYTES = 150;

export const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * A file attached to a message, in RichBody.attachments. `path` is where the file is on the laptop reading the message:
 * the sending daemon removes it before the envelope leaves for another user, and the receiving daemon fills in its own
 * after it has downloaded and checked the file. `error` replaces `path` when the file could not be fetched.
 */
export interface Attachment {
  id: string; // uuid, chosen by the daemon that first stored the file
  name: string; // sanitised, extension kept
  size: number; // bytes
  sha256: string; // hex
  mime?: string;
  path?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Website (cloud mode, uploads.md "Website"): the bytes go straight to Supabase Storage with signed URLs, never
// through the API. A file is readable by its uploader and by the recipients of the messages that name it.

/** POST /api/files: reserve a file and get a URL to PUT its bytes to. `id` may be proposed (the daemon's upload id). */
export interface CloudFileCreate {
  id?: string;
  name: string;
  size: number;
  sha256: string;
  mime?: string;
}
export interface CloudFileCreated {
  id: string;
  name: string; // sanitised
  /** PUT the raw bytes here (Content-Type = the file's type); null when this uploader already finished this id. */
  upload_url: string | null;
  expires_at: string; // the file is deleted after this
}
/** GET /api/files/:id: a short-lived URL to GET the bytes from. */
export interface CloudFileDownload {
  id: string;
  name: string;
  size: number;
  sha256: string;
  mime?: string;
  url: string;
  expires_at: string;
}

/** POST /v1/uploads answer: the stored file on this laptop. */
export interface UploadResult extends Attachment {
  path: string;
  created_at: string;
}

const FORBIDDEN = /[<>:"/\\|?*\x00-\x1f\x7f-\x9f]+/g;
// zero-width, bidi-override and BOM characters, by code point (they hide or reorder text in a name)
const INVISIBLE: [number, number][] = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const visible = (s: string) => [...s].map((ch) => (INVISIBLE.some(([a, b]) => ch.codePointAt(0)! >= a && ch.codePointAt(0)! <= b) ? "_" : ch)).join("");
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** Cut `s` to at most `max` UTF-8 bytes without splitting a character. */
function cutBytes(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (utf8Len(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * A safe file name from whatever the browser or the sender said: the last path part only, no control or
 * bidi characters, none of < > : " / \ | ? *, no leading dot (no hidden files) and no "." or "..". The
 * extension is kept, and the name is at most UPLOAD_NAME_MAX_BYTES bytes. Never returns "".
 */
export function sanitizeFileName(raw: string): string {
  let s = String(raw ?? "").normalize("NFC");
  s = s.split(/[/\\]/).pop() ?? "";
  // brackets too: a name like "[c4 task from …]" must not read as a header in a pane
  s = visible(s).replace(FORBIDDEN, "_").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (!s || /^_+$/.test(s)) s = "file";
  const dot = s.lastIndexOf(".");
  let stem = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot) : "";
  if (utf8Len(ext) > 16 || !/^\.[\p{L}\p{N}_-]+$/u.test(ext)) {
    // not a real extension (too long or odd characters): treat it as part of the name
    stem = s;
    ext = "";
  }
  if (RESERVED.test(stem)) stem = `_${stem}`;
  if (utf8Len(stem + ext) > UPLOAD_NAME_MAX_BYTES) stem = cutBytes(stem, UPLOAD_NAME_MAX_BYTES - utf8Len(ext)).trim() || "file";
  return stem + ext;
}

/** "photo.png", 2 → "photo-2.png": the name tried after a collision. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/** The folder a file lands in: data/uploads/<YYYY-MM-DD>/, by the laptop's local date. */
export function uploadDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** null when `size` fits; otherwise the error to show. `crossesHub` = the file must reach another person's laptop. */
export function sizeError(size: number, crossesHub: boolean): string | null {
  const max = crossesHub ? UPLOAD_MAX_HUB_BYTES : UPLOAD_MAX_LOCAL_BYTES;
  if (size <= max) return null;
  return crossesHub
    ? `${formatBytes(size)} is over the ${formatBytes(max)} limit for files sent to another person`
    : `${formatBytes(size)} is over the ${formatBytes(max)} limit for one file`;
}

/** The lines a pane gets for a message's files: "[attached: /full/path]", or why a file is missing. */
export function attachmentLines(attachments: Attachment[] | undefined): string[] {
  if (!Array.isArray(attachments)) return [];
  // one line each, whatever is in the fields (an error text can come from a server)
  const flat = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+|\s+/g, " ").slice(0, 400);
  return attachments.map((a) =>
    a.path ? `[attached: ${flat(a.path)}]` : `[attachment not available: ${flat(sanitizeFileName(String(a.name ?? "file")))} (${flat(a.error ?? "not downloaded")})]`,
  );
}
