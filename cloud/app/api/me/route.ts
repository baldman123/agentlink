import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, json, route } from "../../../lib/server/http.ts";
import { realtimeBlock } from "../../../lib/server/logic.ts";

export const GET = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  return json(200, { user: caller.user, owner: caller.owner, realtime: await realtimeBlock(d, caller.person) });
});
