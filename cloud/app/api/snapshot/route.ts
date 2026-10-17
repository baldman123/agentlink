import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, json, route } from "../../../lib/server/http.ts";
import { presence } from "../../../lib/server/logic.ts";

export const GET = route(async (req) => {
  const d = getDeps();
  await authenticate(req, d);
  const [users, context] = await Promise.all([presence(d), d.store.listContext()]);
  return json(200, { users, context, last_seq: 0 });
});
