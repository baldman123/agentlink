import { getDeps } from "../../../../../../lib/server/deps.ts";
import { authenticate, HttpError, json, log, route, USER_RE, type Params } from "../../../../../../lib/server/http.ts";

export const POST = route<Params<{ user: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  if (!caller.owner) throw new HttpError(403, "owner_only");
  const { user } = await ctx.params;
  if (!USER_RE.test(user)) throw new HttpError(400, "bad_user");
  if (!(await d.store.revokePerson(user))) return json(404, { error: "not_found", detail: `${user} is not an active invitee` });
  // The API and RLS refuse them from now on; this tells their open daemon/browser to stop.
  await d.broadcaster.send(`user:${user}`, "revoked", { user, at: new Date(d.now()).toISOString() }).catch((e) => log("broadcast.failed", { user, error: String(e) }));
  log("person.revoked", { user });
  return json(200, { ok: true, user });
});
