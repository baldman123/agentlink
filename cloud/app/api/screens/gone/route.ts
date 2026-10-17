import { getDeps } from "../../../../lib/server/deps.ts";
import { AGENT_RE, authenticate, HttpError, json, readJson, route } from "../../../../lib/server/http.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { agent } = await readJson<{ agent?: unknown }>(req);
  if (typeof agent !== "string" || !AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
  await d.broadcaster.send("screens", "screen.gone", { address: `${caller.user}/${agent}` });
  return json(204);
});
