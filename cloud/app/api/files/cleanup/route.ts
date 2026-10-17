// Deletes expired files (7 days), bytes and rows. GET for Vercel Cron, which sends `Authorization: Bearer $CRON_SECRET`;
// POST for the owner, signed in. New uploads also sweep a few each time, so nothing piles up without a cron.
import { safeEqual } from "../../../../lib/server/crypto.ts";
import { getDeps } from "../../../../lib/server/deps.ts";
import { cleanupExpired } from "../../../../lib/server/files.ts";
import { authenticate, HttpError, json, route } from "../../../../lib/server/http.ts";

async function allowed(req: Request): Promise<void> {
  const d = getDeps();
  const auth = req.headers.get("authorization") ?? "";
  if (d.env.cronSecret && auth.startsWith("Bearer ") && safeEqual(auth.slice(7), d.env.cronSecret)) return;
  const caller = await authenticate(req, d);
  if (!caller.owner) throw new HttpError(403, "owner_only");
}

const run = route(async (req) => {
  await allowed(req);
  return json(200, { deleted: await cleanupExpired(getDeps(), 1000) });
});

export const GET = run;
export const POST = run;
