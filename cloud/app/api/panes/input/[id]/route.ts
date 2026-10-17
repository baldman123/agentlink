import { getDeps } from "../../../../../lib/server/deps.ts";
import { authenticate, json, route, type Params } from "../../../../../lib/server/http.ts";

const PENDING_MS = 60_000;

export const GET = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  const row = await d.store.getPaneInput(id);
  if (!row || row.username !== caller.user) return json(404, { error: "not_found" });
  if (row.state === "pending" && d.now() - Date.parse(row.created_at) > PENDING_MS) {
    return json(200, { id, state: "failed", results: Object.fromEntries(row.agents.map((a) => [a, "failed: no_daemon"])) });
  }
  return json(200, row.results ? { id, state: row.state, results: row.results } : { id, state: row.state });
});
