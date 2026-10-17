import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, json, route } from "../../../lib/server/http.ts";

export const GET = route(async (req) => {
  const d = getDeps();
  await authenticate(req, d);
  const q = new URL(req.url).searchParams.get("q") || undefined;
  return json(200, { entries: await d.store.listContext(q?.slice(0, 200)) });
});
