// Claude plan usage, as Claude Code's /usage screen shows it. The daemon collects it (daemon/src/usage.ts) and
// POSTs it to the website (cloud/app/api/usage); the UI reads GET /api/usage and draws UsageMeter.
//
// Source: `claude -p --input-format stream-json` answering a {subtype:"get_usage"} control request. Claude Code
// reads its own login for that; agentlink never sees a token. The request is marked experimental upstream, so
// parseUsage() tolerates missing fields and returns null when nothing usable came back.

export interface UsageWindow {
  pct: number; // 0-100, share of the window used
  resets_at: string | null; // ISO 8601
}

export interface ClaudeUsage {
  plan: string | null; // "pro" | "max" | "team" | "enterprise" | null
  five_hour: UsageWindow | null; // the rolling session limit
  seven_day: UsageWindow | null; // the weekly limit, all models
  scoped: (UsageWindow & { label: string })[]; // weekly per-model limits (Opus, Sonnet, ...), when the plan has them
  collected_at: string; // when the daemon asked
}

export interface UsageRow {
  user: string;
  usage: ClaudeUsage;
  received_at: string; // when the website stored it
}

/** GET /api/usage */
export interface UsageListResponse {
  usage: UsageRow[];
}

export const USAGE_INTERVAL_MS = 5 * 60_000;
/** Older than this, the UI greys the meter out: the daemon stopped reporting. */
export const USAGE_STALE_MS = 20 * 60_000;

/** Meter colours: yellow from 75% used, red from 90%. */
export const USAGE_WARN_PCT = 75;
export const USAGE_DANGER_PCT = 90;

export function usageLevel(pct: number): "ok" | "warn" | "danger" {
  return pct >= USAGE_DANGER_PCT ? "danger" : pct >= USAGE_WARN_PCT ? "warn" : "ok";
}

/** Time left until a window resets: "45m", "3h", "2d 5h"; null when unknown or already past. */
export function untilText(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt) - now;
  if (!(ms > 0)) return null;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null);
const when = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function win(v: unknown): UsageWindow | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pct = num(o.utilization ?? o.pct);
  return pct === null ? null : { pct, resets_at: when(o.resets_at) };
}

/** The `response` of a get_usage control_response -> ClaudeUsage, or null when rate limits don't apply. */
export function parseUsage(resp: unknown, now = new Date()): ClaudeUsage | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const rl = r.rate_limits as Record<string, unknown> | null | undefined;
  if (!rl || typeof rl !== "object") return null;
  const five_hour = win(rl.five_hour);
  const seven_day = win(rl.seven_day);
  if (!five_hour && !seven_day) return null;
  const scoped: ClaudeUsage["scoped"] = [];
  const seen = new Set<string>();
  const add = (label: string, v: unknown) => {
    const w = win(v);
    if (w && !seen.has(label.toLowerCase())) {
      seen.add(label.toLowerCase());
      scoped.push({ label, ...w });
    }
  };
  add("Opus", rl.seven_day_opus);
  add("Sonnet", rl.seven_day_sonnet);
  if (Array.isArray(rl.model_scoped)) {
    for (const m of rl.model_scoped) {
      const label = (m as Record<string, unknown>)?.display_name;
      if (typeof label === "string" && label.trim()) add(label.trim().slice(0, 24), m);
    }
  }
  return {
    plan: typeof r.subscription_type === "string" ? r.subscription_type : null,
    five_hour,
    seven_day,
    scoped: scoped.slice(0, 4),
    collected_at: now.toISOString(),
  };
}

/** Server-side check of a POSTed ClaudeUsage; returns a clean copy or null. */
export function validUsage(v: unknown): ClaudeUsage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const collected = when(o.collected_at);
  if (!collected) return null;
  const five_hour = o.five_hour == null ? null : win(o.five_hour);
  const seven_day = o.seven_day == null ? null : win(o.seven_day);
  if (!five_hour && !seven_day) return null;
  const scoped = Array.isArray(o.scoped)
    ? o.scoped.slice(0, 4).flatMap((s) => {
        const w = win(s);
        const label = (s as Record<string, unknown>)?.label;
        return w && typeof label === "string" && label.trim() ? [{ label: label.trim().slice(0, 24), ...w }] : [];
      })
    : [];
  const plan = typeof o.plan === "string" ? o.plan.slice(0, 24) : null;
  return { plan, five_hour, seven_day, scoped, collected_at: collected };
}
