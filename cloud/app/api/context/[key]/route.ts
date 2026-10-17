import type { ContextKind } from "../../../../../contracts/index.ts";
import { getDeps } from "../../../../lib/server/deps.ts";
import { AGENT_RE, authenticate, HttpError, json, readJson, route, type Params } from "../../../../lib/server/http.ts";
import { notifyContext } from "../../../../lib/server/logic.ts";

const KEY_RE = /^[a-z0-9._-]{1,64}$/;
const KINDS: ContextKind[] = ["note", "decision", "api_spec"];

async function keyOf(ctx: Params<{ key: string }>): Promise<string> {
  const key = decodeURIComponent((await ctx.params).key);
  if (!KEY_RE.test(key)) throw new HttpError(400, "bad_key");
  return key;
}

export const GET = route<Params<{ key: string }>>(async (req, ctx) => {
  const d = getDeps();
  await authenticate(req, d);
  const e = await d.store.getContext(await keyOf(ctx));
  return e ? json(200, e) : json(404, { error: "not_found" });
});

/** Write with optimistic versioning; author = <caller>/<agent ?? "orchestrator">. */
export const PUT = route<Params<{ key: string }>>(async (req, ctx) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const key = await keyOf(ctx);
  const b = await readJson<{ title?: unknown; kind?: unknown; body?: unknown; base_version?: unknown; agent?: unknown }>(req, 512 * 1024);
  if (!KINDS.includes(b.kind as ContextKind)) throw new HttpError(400, "bad_kind");
  if (typeof b.title !== "string" || typeof b.body !== "string" || b.title.length > 200) throw new HttpError(400, "bad_body");
  if (b.base_version !== undefined && !Number.isInteger(b.base_version)) throw new HttpError(400, "bad_base_version");
  if (b.agent !== undefined && (typeof b.agent !== "string" || !AGENT_RE.test(b.agent))) throw new HttpError(400, "bad_author");
  const author = `${caller.user}/${(b.agent as string | undefined) ?? "orchestrator"}`;
  const r = await d.store.putContext(key, { title: b.title, kind: b.kind as ContextKind, body: b.body, author, base_version: b.base_version as number | undefined });
  if (r.status === 409) return json(409, { error: "conflict", current: r.current });
  await notifyContext(d, r.entry);
  return json(200, r.entry);
});

export const DELETE = route<Params<{ key: string }>>(async (req, ctx) => {
  const d = getDeps();
  await authenticate(req, d);
  return (await d.store.deleteContext(await keyOf(ctx))) ? json(204) : json(404, { error: "not_found" });
});
