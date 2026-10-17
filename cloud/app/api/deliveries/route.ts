import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, json, route } from "../../../lib/server/http.ts";

/** Resume: every unacked delivery for the caller with seq > since_seq, oldest first. */
export const GET = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const q = new URL(req.url).searchParams;
  const since = Math.max(0, parseInt(q.get("since_seq") ?? "0", 10) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(q.get("limit") ?? "500", 10) || 500));
  const deliveries = await d.store.pendingDeliveries(caller.user, since, limit);
  return json(200, { deliveries, last_seq: deliveries.length ? deliveries[deliveries.length - 1].seq : since });
});
