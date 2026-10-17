// Node-only helpers for uploads.md: stream bytes to disk with a size cap and a sha256, then put the file in place.
// Used by the daemon (uploads, downloads from the hub) and the hub (relayed files). The UI must not import this.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { numberedName } from "./uploads.ts";

export class UploadTooLarge extends Error {
  constructor(public max: number) {
    super(`file is larger than ${max} bytes`);
  }
}
export class UploadMismatch extends Error {}

/**
 * Write `src` to a hidden temp file in `dir`, counting and hashing as it goes. Stops (and deletes the temp file)
 * as soon as it passes `maxBytes`, or at the end if `expectSize`/`expectSha` don't match. Returns the temp path.
 */
export async function receiveFile(
  src: AsyncIterable<Uint8Array>,
  o: { dir: string; maxBytes: number; expectSize?: number; expectSha?: string },
): Promise<{ tmp: string; size: number; sha256: string }> {
  fs.mkdirSync(o.dir, { recursive: true });
  const tmp = path.join(o.dir, `.${randomUUID()}.part`);
  const out = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of src) {
      size += chunk.length;
      if (size > o.maxBytes) throw new UploadTooLarge(o.maxBytes);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const sha256 = hash.digest("hex");
    if (o.expectSize !== undefined && size !== o.expectSize) throw new UploadMismatch(`got ${size} bytes, expected ${o.expectSize}`);
    if (o.expectSha !== undefined && sha256 !== o.expectSha) throw new UploadMismatch("sha256 does not match");
    return { tmp, size, sha256 };
  } catch (err) {
    // the stream opens its file asynchronously: wait for it to close, or the file appears after the rm
    if (!out.closed) await new Promise<void>((r) => out.once("close", () => r()).destroy());
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Move a finished temp file to `dir/name`, or `name-2`, `name-3`… if that is taken. A hard link claims the name
 * atomically (it fails if the name exists), so two uploads with the same name never overwrite each other.
 */
export function placeUnique(tmp: string, dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, n === 1 ? name : numberedName(name, n));
    try {
      fs.linkSync(tmp, candidate);
      fs.rmSync(tmp, { force: true });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`no free name for ${name} in ${dir}`);
}
