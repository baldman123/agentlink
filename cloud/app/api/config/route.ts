import { getDeps } from "../../../lib/server/deps.ts";
import { json, route } from "../../../lib/server/http.ts";

export const dynamic = "force-dynamic";

/** Public: the Supabase URL and anon key are meant for clients (RLS is the gate). */
export const GET = route(async () => {
  const d = getDeps();
  return json(200, { supabase_url: d.env.supabaseUrl, supabase_anon_key: d.env.supabaseAnonKey, hub_id: await d.store.hubId(), hub_name: d.env.hubName });
});
