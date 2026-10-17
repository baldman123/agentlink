// GET /api/files/:id -> {id, name, size, sha256, mime?, url, expires_at}: a 10-minute download URL, for the uploader and
// the people the file was sent to; anyone else gets 404 (contracts/uploads.md "Website").
import { getDeps } from "../../../../lib/server/deps.ts";
import { downloadFor } from "../../../../lib/server/files.ts";
import { authenticate, json, route, type Params } from "../../../../lib/server/http.ts";

export const GET = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  return json(200, await downloadFor(d, caller.user, id));
});
