import { getDeps } from "../../../../lib/server/deps.ts";
import { authenticate, HttpError, json, readJson, route } from "../../../../lib/server/http.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { ids } = await readJson<{ ids?: unknown }>(req);
  if (!Array.isArray(ids) || ids.length > 500 || !ids.every((i) => typeof i === "string" && i.length > 0 && i.length <= 128)) {
    throw new HttpError(400, "bad_ids", "ids: up to 500 message ids");
  }
  return json(200, { acked: ids.length ? await d.store.ack(caller.user, ids as string[]) : 0 });
});
