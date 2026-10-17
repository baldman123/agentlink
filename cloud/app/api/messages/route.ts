import { ADDRESS_RE } from "../../../../contracts/index.ts";
import { getDeps } from "../../../lib/server/deps.ts";
import { authenticate, HttpError, json, readJson, route } from "../../../lib/server/http.ts";
import { acceptEnvelope, envelopeFromForm } from "../../../lib/server/logic.ts";

const clamp = (v: string | null, def: number, min: number, max: number) => {
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** History, newest first, always narrowed to the caller's own messages plus "*" broadcasts. */
export const GET = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const q = new URL(req.url).searchParams;
  const address = q.get("address") || undefined;
  const withAddr = q.get("with") || undefined;
  for (const a of [address, withAddr]) if (a !== undefined && a !== "*" && !ADDRESS_RE.test(a)) throw new HttpError(400, "bad_address");
  const before = q.get("before") || undefined;
  if (before !== undefined && Number.isNaN(Date.parse(before))) throw new HttpError(400, "bad_before");
  const messages = await d.store.queryMessages({ viewer: caller.user, address, with: withAddr, before, limit: clamp(q.get("limit"), 50, 1, 500) });
  return json(200, { messages });
});

/** Send: { envelope } from a daemon, or the browser form { to, type, body, reply_to?, from_agent? }. */
export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const b = await readJson(req);
  if (b.envelope === undefined && (b.from_agent !== undefined && (typeof b.from_agent !== "string" || !/^[a-z0-9_-]{1,32}$/.test(b.from_agent)))) {
    return json(422, { id: "", rejected: true, reason: "bad_address" });
  }
  const env = b.envelope !== undefined ? b.envelope : envelopeFromForm(caller.user, b, d.now());
  const r = await acceptEnvelope(d, caller.user, env);
  return json("accepted" in r ? 200 : 422, r);
});
