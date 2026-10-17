// The daemon's full-state sync of its person's pending calls (contracts/calls.ts). Rows it no longer lists are
// dropped; the reply carries the answers made on the site for it to deliver into claude4.
import { CALLS_MAX, validCallUpload, type CallSyncResponse, type CallUpload } from "../../../../../contracts/calls.ts";
import { getDeps } from "../../../../lib/server/deps.ts";
import { authenticate, HttpError, json, log, readJson, route } from "../../../../lib/server/http.ts";

export const PUT = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const b = await readJson<{ calls?: unknown }>(req, 512 * 1024);
  if (!Array.isArray(b.calls) || b.calls.length > CALLS_MAX) throw new HttpError(400, "bad_calls");
  const calls: CallUpload[] = [];
  const seen = new Set<string>();
  for (const raw of b.calls) {
    const c = validCallUpload(raw);
    if (!c) throw new HttpError(400, "bad_call", typeof (raw as any)?.id === "string" ? String((raw as any).id).slice(0, 20) : undefined);
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    calls.push(c);
  }
  const answers = await d.store.syncCalls(caller.user, calls);
  if (answers.length) log("calls.answers_out", { user: caller.user, ids: answers.map((a) => a.id) });
  const body: CallSyncResponse = { answers };
  return json(200, body);
});
