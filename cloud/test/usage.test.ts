// Claude usage meters: the parser (contracts/usage.ts), the daemon's stream-json reader, the /api/usage route,
// and the meter's thresholds and reset text.   cd cloud && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { setDeps } from "../lib/server/deps.ts";
import { MemoryStore, RecordingBroadcaster } from "./memory-store.ts";
import { parseUsage, untilText, usageLevel as level, validUsage } from "../../contracts/usage.ts";
import { findUsageResponse } from "../../daemon/src/usage.ts";
import * as login from "../app/api/auth/login/route.ts";
import * as people from "../app/api/admin/people/route.ts";
import * as revoke from "../app/api/admin/people/[user]/revoke/route.ts";
import * as usage from "../app/api/usage/route.ts";

// A real get_usage answer from Claude Code 2.1.302 (team plan), trimmed of the null buckets.
const REAL = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 22216, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 14, resets_at: "2026-10-17T07:19:59.602285+00:00", limit_dollars: null },
    seven_day: { utilization: 35, resets_at: "2026-10-20T11:59:59.602306+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-20T12:00:00+00:00" }],
  },
  behaviors: null,
};

test("parseUsage: real get_usage answer -> 5h, weekly, scoped", () => {
  const u = parseUsage(REAL, new Date("2026-10-17T05:00:00Z"))!;
  assert.equal(u.plan, "team");
  assert.deepEqual(u.five_hour, { pct: 14, resets_at: "2026-10-17T07:19:59.602Z" });
  assert.deepEqual(u.seven_day, { pct: 35, resets_at: "2026-10-20T11:59:59.602Z" });
  assert.deepEqual(u.scoped, [{ label: "Fable", pct: 0, resets_at: "2026-10-20T12:00:00.000Z" }]);
  assert.equal(u.collected_at, "2026-10-17T05:00:00.000Z");
});

test("parseUsage: Opus bucket, clamping, and no-rate-limit answers", () => {
  const u = parseUsage({ rate_limits: { five_hour: { utilization: 130, resets_at: null }, seven_day_opus: { utilization: 80, resets_at: "2026-10-20T12:00:00Z" } } })!;
  assert.equal(u.five_hour!.pct, 100);
  assert.equal(u.seven_day, null);
  assert.deepEqual(u.scoped.map((s) => s.label), ["Opus"]);
  assert.equal(parseUsage({ rate_limits_available: false, rate_limits: null }), null);
  assert.equal(parseUsage({ rate_limits: { five_hour: null, seven_day: null } }), null);
  assert.equal(parseUsage("nope"), null);
});

test("findUsageResponse: picks our control_response out of stream-json, surfaces errors", () => {
  const ok = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "not json at all",
    JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "agentlink-usage", response: REAL } }),
  ].join("\n");
  assert.equal((findUsageResponse(ok) as any).subscription_type, "team");
  assert.equal(findUsageResponse(JSON.stringify({ type: "result" })), undefined);
  const err = JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: "agentlink-usage", error: "get_usage is not supported in this context" } });
  assert.throws(() => findUsageResponse(err), /not supported/);
});

test("validUsage rejects junk and strips extras", () => {
  const good = parseUsage(REAL)!;
  assert.deepEqual(validUsage({ ...good, token: "sk-should-not-survive" }), good);
  assert.equal(validUsage(null), null);
  assert.equal(validUsage({ ...good, collected_at: "yesterday-ish" }), null);
  assert.equal(validUsage({ ...good, five_hour: null, seven_day: null }), null);
  assert.equal(validUsage({ ...good, five_hour: { pct: "lots" }, seven_day: null }), null);
});

test("meter thresholds and reset text", () => {
  assert.equal(level(74), "ok");
  assert.equal(level(75), "warn");
  assert.equal(level(89.9), "warn");
  assert.equal(level(90), "danger");
  const now = Date.parse("2026-10-17T05:00:00Z");
  assert.equal(untilText("2026-10-17T05:20:00Z", now), "20m");
  assert.equal(untilText("2026-10-17T07:20:00Z", now), "2h");
  assert.equal(untilText("2026-10-20T12:00:00Z", now), "3d 7h");
  assert.equal(untilText("2026-10-17T04:00:00Z", now), null);
  assert.equal(untilText(null, now), null);
});

// ---------------------------------------------------------------- route

const ORIGIN = "https://agentlink.test";
const MASTER = "master-code-for-tests-0123456789";
const env = {
  owner: "bryant", masterCode: MASTER, sessionSecret: "s".repeat(40), supabaseUrl: "https://sb.test",
  supabaseAnonKey: "anon-key", supabaseServiceKey: "service-key", supabaseJwtSecret: "j".repeat(40), hubName: "agentlink-test",
};

type Handler = (req: Request, ctx: any) => Promise<Response>;
async function call(h: Handler, method: string, path: string, o: { body?: unknown; bearer?: string; params?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "x-forwarded-proto": "https", host: "agentlink.test", "x-forwarded-for": "203.0.113.7" };
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await h(new Request(`${ORIGIN}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("/api/usage: daemon POSTs its own sample, everyone GETs all of them, revoked people drop out", async () => {
  const store = new MemoryStore();
  setDeps({ env, store, broadcaster: new RecordingBroadcaster(), now: () => Date.now() });
  const owner = (await call(login.POST, "POST", "/api/auth/login", { body: { code: MASTER } })).body.session;
  const inv = await call(people.POST, "POST", "/api/admin/people", { bearer: owner, body: { user: "sam" } });
  const sam = (await call(login.POST, "POST", "/api/auth/login", { body: { code: inv.body.code } })).body.session;

  assert.equal((await call(usage.GET, "GET", "/api/usage")).status, 401);
  assert.equal((await call(usage.POST, "POST", "/api/usage", { body: { usage: parseUsage(REAL) } })).status, 401);
  assert.equal((await call(usage.POST, "POST", "/api/usage", { bearer: sam, body: { usage: { nope: 1 } } })).status, 400);

  assert.equal((await call(usage.POST, "POST", "/api/usage", { bearer: sam, body: { usage: parseUsage(REAL), user: "bryant" } })).status, 204);
  const mine = { ...parseUsage(REAL)!, five_hour: { pct: 92, resets_at: null } };
  assert.equal((await call(usage.POST, "POST", "/api/usage", { bearer: owner, body: { usage: mine } })).status, 204);

  const got = await call(usage.GET, "GET", "/api/usage", { bearer: sam });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.usage.map((r: any) => [r.user, r.usage.five_hour.pct]), [["bryant", 92], ["sam", 14]], "stored under the caller, not a body field");

  assert.equal((await call(revoke.POST, "POST", "/api/admin/people/sam/revoke", { bearer: owner, params: { user: "sam" } })).status, 200);
  assert.deepEqual((await call(usage.GET, "GET", "/api/usage", { bearer: owner })).body.usage.map((r: any) => r.user), ["bryant"]);
});
