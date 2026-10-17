import { getDeps } from "../../../lib/server/deps.ts";
import { AGENT_RE, authenticate, HttpError, json, readJson, route } from "../../../lib/server/http.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { agents } = await readJson<{ agents?: unknown }>(req);
  if (!Array.isArray(agents) || agents.length > 50 || !agents.every((a) => typeof a === "string" && AGENT_RE.test(a))) {
    throw new HttpError(400, "bad_agents");
  }
  await d.store.heartbeat(caller.user, agents as string[]);
  return json(204);
});
