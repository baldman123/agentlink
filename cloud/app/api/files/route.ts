// POST /api/files {id?, name, size, sha256, mime?} -> 201 {id, name, upload_url, expires_at} (contracts/uploads.md "Website").
// The client then PUTs the bytes to upload_url (straight to Storage) and calls POST /api/files/:id/complete.
import { getDeps } from "../../../lib/server/deps.ts";
import { createUpload } from "../../../lib/server/files.ts";
import { authenticate, json, readJson, route } from "../../../lib/server/http.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  return json(201, await createUpload(d, caller.user, await readJson(req, 4096)));
});
