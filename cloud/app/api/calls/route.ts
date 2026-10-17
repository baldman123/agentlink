// "Your calls" (contracts/calls.ts): the signed-in person's own pending calls, oldest first. Nobody sees another
// person's calls, the owner included.
import type { CallListResponse } from "../../../../contracts/calls.ts";
import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, json, route } from "../../../lib/server/http.ts";

export const GET = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const body: CallListResponse = { calls: await d.store.listCalls(caller.user) };
  return json(200, body);
});
