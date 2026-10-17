// Yes or No (with an optional note) on one of the caller's own pending calls. The call shows as "answering" until
// the caller's daemon delivers it into claude4 and stops listing it.
import { CALL_ID_RE, validCallAnswer } from "../../../../../../contracts/calls.ts";
import { getDeps } from "../../../../../lib/server/deps.ts";
import { authenticate, HttpError, json, log, readJson, route, type Params } from "../../../../../lib/server/http.ts";

export const POST = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  if (!CALL_ID_RE.test(id)) throw new HttpError(404, "not_found");
  const body = await readJson(req, 8 * 1024);
  const call = (await d.store.listCalls(caller.user)).find((c) => c.id === id);
  if (!call) throw new HttpError(404, "not_found");
  const answer = validCallAnswer(body, call.kind);
  if (!answer) throw new HttpError(400, "bad_answer");
  const r = await d.store.answerCall(caller.user, id, answer);
  if (!r.ok) throw new HttpError(r.reason === "not_found" ? 404 : 409, r.reason);
  log("calls.answered", { user: caller.user, id, choice: answer.choice }); // never the note
  return json(200, { call: r.call });
});
