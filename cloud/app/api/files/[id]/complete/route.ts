// POST /api/files/:id/complete -> {id, size}: the uploader's PUT is done; the API checks Storage has every byte before
// the file can be attached to a message (contracts/uploads.md "Website").
import { getDeps } from "../../../../../lib/server/deps.ts";
import { completeUpload } from "../../../../../lib/server/files.ts";
import { authenticate, json, route, type Params } from "../../../../../lib/server/http.ts";

export const POST = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  return json(200, await completeUpload(d, caller.user, id));
});
