import { getDeps } from "../../../../lib/server/deps.ts";
import { SESSION_TTL_S } from "../../../../lib/server/crypto.ts";
import { clientIp, isHttps, json, readJson, route } from "../../../../lib/server/http.ts";
import { login, sessionCookie, tokenBundle } from "../../../../lib/server/logic.ts";

export const POST = route(async (req) => {
  const d = getDeps();
  const body = await readJson<{ code?: unknown; user?: unknown }>(req, 4096);
  const person = await login(d, body.code, body.user, clientIp(req));
  const bundle = await tokenBundle(d, person);
  return json(200, bundle, { "set-cookie": sessionCookie(bundle.session, isHttps(req), SESSION_TTL_S) });
});
