import { getDeps } from "../../../../lib/server/deps.ts";
import { inputSig, sha256hex } from "../../../../lib/server/crypto.ts";
import { authenticate, HttpError, json, log, readJson, route } from "../../../../lib/server/http.ts";
import { isOnline } from "../../../../lib/server/logic.ts";

const PANES = new Set(["orchestrator", "worker-1", "worker-2", "worker-3", "worker-4"]);

/**
 * Type into the caller's OWN panes (cloud-api.md "Typing into your own panes"). The frame goes only to the private
 * channel input:<caller>, signed with the caller's own code hash. The text is never stored or logged.
 */
export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  if (caller.via === "cookie" && req.headers.get("x-agentlink-input") !== "1") throw new HttpError(403, "missing_header", "X-Agentlink-Input: 1");
  const b = await readJson<{ agents?: unknown; text?: unknown; submit?: unknown }>(req, 32 * 1024);
  const agents = b.agents;
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 5 || !agents.every((a) => typeof a === "string" && PANES.has(a)) || new Set(agents).size !== agents.length) {
    throw new HttpError(400, "bad_agents", "a non-empty subset of orchestrator, worker-1..worker-4");
  }
  if (typeof b.text !== "string" || b.text.length < 1 || b.text.length > 4000) throw new HttpError(400, "bad_text", "1..4000 characters");
  if (b.submit !== undefined && typeof b.submit !== "boolean") throw new HttpError(400, "bad_submit");
  if (!isOnline(caller.person, d.now())) throw new HttpError(503, "no_daemon");

  const codeHash = caller.owner ? sha256hex(d.env.masterCode) : caller.person.code_hash;
  if (!codeHash) throw new HttpError(500, "no_code");
  const id = crypto.randomUUID();
  const frame = { id, user: caller.user, agents: agents as string[], text: b.text, submit: b.submit !== false, at: new Date(d.now()).toISOString() };
  await d.store.insertPaneInput({ id, username: caller.user, agents: frame.agents, chars: frame.text.length });
  await d.broadcaster.send(`input:${caller.user}`, "input", { ...frame, sig: inputSig(codeHash, frame) });
  log("input.requested", { id, user: caller.user, agents: frame.agents, chars: frame.text.length });
  return json(202, { id });
});
