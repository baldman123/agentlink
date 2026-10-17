import { getDeps } from "../../../lib/server/deps.ts";
import { json, route } from "../../../lib/server/http.ts";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const d = getDeps();
  return json(200, { ok: true, hub_id: await d.store.hubId(), hub_name: d.env.hubName, protocol: "cloud-1" });
});
