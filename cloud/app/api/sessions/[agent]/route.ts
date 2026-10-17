import type { SessionKind, SessionStatus } from "../../../../../contracts/index.ts";
import { getDeps } from "../../../../lib/server/deps.ts";
import { AGENT_RE, authenticate, HttpError, json, readJson, route, type Params } from "../../../../lib/server/http.ts";

const KINDS: SessionKind[] = ["orchestrator", "worker", "human"];
const STATUSES: SessionStatus[] = ["idle", "working", "waiting", "error", "offline"];

async function agentOf(ctx: Params<{ agent: string }>): Promise<string> {
  const { agent } = await ctx.params;
  if (!AGENT_RE.test(agent)) throw new HttpError(400, "bad_agent");
  return agent;
}

/** Upsert one of the caller's own sessions (the address is always <caller>/<agent>). */
export const PUT = route<Params<{ agent: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const agent = await agentOf(ctx);
  const b = await readJson<{ kind?: unknown; status?: unknown; task?: unknown }>(req);
  if (!KINDS.includes(b.kind as SessionKind) || !STATUSES.includes(b.status as SessionStatus)) throw new HttpError(400, "bad_session");
  const task = typeof b.task === "string" ? b.task.slice(0, 500) : "";
  const { last_heartbeat, ...session } = await d.store.upsertSession(caller.user, agent, b.kind as SessionKind, b.status as SessionStatus, task);
  return json(200, session);
});

export const DELETE = route<Params<{ agent: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const agent = await agentOf(ctx);
  await d.store.deleteSession(`${caller.user}/${agent}`);
  return json(204);
});
