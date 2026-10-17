import { getDeps } from "../../../../lib/server/deps.ts";
import { SESSION_TTL_S } from "../../../../lib/server/crypto.ts";
import { authenticate, isHttps, json, route } from "../../../../lib/server/http.ts";
import { sessionCookie, tokenBundle } from "../../../../lib/server/logic.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const bundle = await tokenBundle(d, caller.person);
  const headers: Record<string, string> = caller.via === "cookie" ? { "set-cookie": sessionCookie(bundle.session, isHttps(req), SESSION_TTL_S) } : {};
  return json(200, bundle, headers);
});
