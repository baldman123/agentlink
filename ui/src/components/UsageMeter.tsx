// Claude plan usage for one person: the 5-hour session limit and the weekly limit (plus any per-model weekly
// limit, e.g. Opus), each as a thin bar with % used and time to reset. Bars go yellow at 75% and red at 90%.
// Data: GET /api/usage on the website (contracts/usage.ts), polled once a minute and shared by every meter on
// the page. Where that route doesn't exist (the LAN UI) the meter renders nothing.
import { useEffect, useState } from "react";
import { untilText, usageLevel as level, USAGE_STALE_MS, type ClaudeUsage, type UsageListResponse, type UsageWindow } from "../../../contracts/usage.ts";
import { useNow } from "./bits.tsx";

const POLL_MS = 60_000;

// ---------------------------------------------------------------- shared poller

type Listener = (m: Map<string, ClaudeUsage>) => void;
let data = new Map<string, ClaudeUsage>();
let listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let disabled = false;

async function poll() {
  try {
    const r = await fetch("/api/usage", { credentials: "same-origin" });
    // no usage route here (LAN UI: a 404, or the dev server's index.html)
    if (r.status === 404 || (r.ok && !r.headers.get("content-type")?.includes("json"))) return stopPolling(true);
    if (!r.ok) return;
    const body = (await r.json()) as UsageListResponse;
    data = new Map(body.usage.map((row) => [row.user, row.usage]));
    for (const l of listeners) l(data);
  } catch {
    // offline for a moment: keep the last numbers
  }
}

function stopPolling(off: boolean) {
  disabled ||= off;
  if (timer) clearInterval(timer);
  timer = null;
}

function subscribe(l: Listener) {
  listeners.add(l);
  if (!timer && !disabled) {
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) stopPolling(false);
  };
}

/** Test/screenshot hook: replace the polled data. */
export function setUsageForTests(rows: Record<string, ClaudeUsage>) {
  data = new Map(Object.entries(rows));
  disabled = true;
  for (const l of listeners) l(data);
}

export function useUsage(user: string): ClaudeUsage | null {
  const [u, setU] = useState<ClaudeUsage | null>(() => data.get(user) ?? null);
  useEffect(() => subscribe((m) => setU(m.get(user) ?? null)), [user]);
  return u;
}

const FILL = { ok: "var(--idle)", warn: "var(--warn)", danger: "var(--error)" } as const;

// ---------------------------------------------------------------- view

const S = {
  strip: { position: "relative", zIndex: 1, display: "flex", flexWrap: "wrap", gap: "4px 14px", margin: "-4px 0 10px", font: '500 10.5px/1.2 "JetBrains Mono Variable", monospace', color: "var(--muted)" },
  item: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  label: { color: "var(--faint)", letterSpacing: "0.04em", textTransform: "uppercase" },
  track: { width: 54, height: 5, borderRadius: 3, background: "var(--sunk)", boxShadow: "inset 0 0 0 1px var(--line)", overflow: "hidden", flex: "none" },
  pct: { fontWeight: 700, fontVariantNumeric: "tabular-nums", minWidth: "3ch", textAlign: "right" },
  reset: { color: "var(--faint)" },
} satisfies Record<string, React.CSSProperties>;

function Bar({ label, w, now }: { label: string; w: UsageWindow; now: number }) {
  const lv = level(w.pct);
  const pct = Math.round(w.pct);
  const until = untilText(w.resets_at, now);
  const resetAt = w.resets_at ? new Date(w.resets_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <span style={S.item} className={`usage-bar usage-${lv}`} title={`${label}: ${pct}% used${resetAt ? `, resets ${resetAt}` : ""}`}>
      <span style={S.label}>{label}</span>
      <span style={S.track} role="meter" aria-label={`${label} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ display: "block", height: "100%", width: `${Math.max(pct, pct > 0 ? 4 : 0)}%`, background: FILL[lv], borderRadius: 3, transition: "width .4s ease" }} />
      </span>
      <span style={{ ...S.pct, color: lv === "ok" ? "var(--text)" : FILL[lv] }}>{pct}%</span>
      {until && <span style={S.reset}>resets in {until}</span>}
    </span>
  );
}

export function UsageView({ usage, now }: { usage: ClaudeUsage; now: number }) {
  const age = now - Date.parse(usage.collected_at);
  const stale = age > USAGE_STALE_MS;
  return (
    <div
      className="usage-strip"
      style={{ ...S.strip, opacity: stale ? 0.5 : 1 }}
      title={stale ? `Claude usage: last report ${Math.round(age / 60_000)}m ago` : `Claude usage${usage.plan ? ` (${usage.plan} plan)` : ""}, as of ${new Date(usage.collected_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
    >
      {usage.five_hour && <Bar label="5h" w={usage.five_hour} now={now} />}
      {usage.seven_day && <Bar label="week" w={usage.seven_day} now={now} />}
      {/* per-model weekly limits: Opus always (it's the one people hit), others once they're in use */}
      {usage.scoped.filter((s) => s.pct > 0 || s.label === "Opus").map((s) => <Bar key={s.label} label={s.label} w={s} now={now} />)}
    </div>
  );
}

export function UsageMeter({ user }: { user: string }) {
  const usage = useUsage(user);
  const now = useNow(60_000);
  return usage ? <UsageView usage={usage} now={now} /> : null;
}
