import { getDeps } from "../../../../lib/server/deps.ts";
import { authenticate, json, route, type Params } from "../../../../lib/server/http.ts";

const userOf = (a: string) => a.split("/")[0];

export const GET = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  const m = await d.store.getMessage(decodeURIComponent(id));
  const visible = m && (userOf(m.from) === caller.user || m.to === "*" || userOf(m.to) === caller.user);
  return visible ? json(200, m) : json(404, { error: "not_found" });
});
