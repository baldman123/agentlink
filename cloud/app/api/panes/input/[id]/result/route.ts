import { getDeps } from "../../../../../../lib/server/deps.ts";
import { authenticate, HttpError, json, log, readJson, route, type Params } from "../../../../../../lib/server/http.ts";

const RESULT_RE = /^(sent|skipped: prompt_open|skipped: no_pane|failed: .{1,200})$/;

/** The caller's daemon reports what the bridge did with one of the caller's own inputs. */
export const POST = route<Params<{ id: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { id } = await ctx.params;
  const b = await readJson<{ state?: unknown; results?: unknown }>(req);
  const state = b.state ?? "done";
  if (state !== "done" && state !== "failed") throw new HttpError(400, "bad_state");
  const results = b.results as Record<string, unknown> | undefined;
  if (!results || typeof results !== "object" || Array.isArray(results) || !Object.values(results).every((v) => typeof v === "string" && RESULT_RE.test(v))) {
    throw new HttpError(400, "bad_results");
  }
  const row = await d.store.getPaneInput(id);
  if (!row || row.username !== caller.user) return json(404, { error: "not_found" });
  const picked = Object.fromEntries(row.agents.filter((a) => a in results).map((a) => [a, results[a] as string]));
  if (!(await d.store.setPaneInputResult(id, caller.user, state, picked))) throw new HttpError(409, "already_reported");
  log("input.result", { id, user: caller.user, state, results: picked });
  return json(204);
});
