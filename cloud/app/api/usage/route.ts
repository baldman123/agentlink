// Claude plan usage (contracts/usage.ts). POST: a daemon reports its person's latest sample. GET: everyone's
// latest sample, for the usage meters. One row per person; revoked people are left out.
import { validUsage, type UsageListResponse } from "../../../../contracts/usage.ts";
import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, HttpError, json, readJson, route } from "../../../lib/server/http.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { usage } = await readJson<{ usage?: unknown }>(req, 8 * 1024);
  const clean = validUsage(usage);
  if (!clean) throw new HttpError(400, "bad_usage");
  await d.store.putUsage(caller.user, clean);
  return json(204);
});

export const GET = route(async (req) => {
  const d = getDeps();
  await authenticate(req, d);
  const [rows, people] = await Promise.all([d.store.listUsage(), d.store.listPeople()]);
  const active = new Set(people.filter((p) => !p.revoked_at).map((p) => p.username));
  const body: UsageListResponse = { usage: rows.filter((r) => active.has(r.user)) };
  return json(200, body);
});
