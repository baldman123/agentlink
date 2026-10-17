import { SCREEN_MAX_BYTES } from "../../../../contracts/index.ts";
import { getDeps } from "../../../lib/server/deps.ts";
import { AGENT_RE, authenticate, HttpError, json, readJson, route } from "../../../lib/server/http.ts";

// Best effort, per server instance: at most 2 updates per pane per 3s (the daemon throttles to 1 per 3s itself).
const recent = new Map<string, number[]>();
const WINDOW_MS = 3000;
const MAX_IN_WINDOW = 2;

function throttled(address: string, now: number): boolean {
  const times = (recent.get(address) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= MAX_IN_WINDOW) {
    recent.set(address, times);
    return true;
  }
  times.push(now);
  recent.set(address, times);
  if (recent.size > 5000) recent.clear();
  return false;
}

/** Relays one pane's screen on the private "screens" channel. Never stored. */
export const POST = route(async (req) => {
  const d = getDeps();
  const caller = await authenticate(req, d);
  const { screen: s } = await readJson<{ screen?: any }>(req, SCREEN_MAX_BYTES * 2);
  const dim = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2000;
  if (!s || typeof s !== "object" || typeof s.agent !== "string" || !AGENT_RE.test(s.agent)) throw new HttpError(400, "bad_agent");
  if (typeof s.text !== "string" || Buffer.byteLength(s.text, "utf8") > SCREEN_MAX_BYTES) throw new HttpError(400, "bad_text");
  if (!dim(s.cols) || !dim(s.rows)) throw new HttpError(400, "bad_size");
  const address = `${caller.user}/${s.agent}`;
  if (!(await d.store.getSession(address))) throw new HttpError(400, "no_session");
  if (throttled(address, d.now())) throw new HttpError(429, "too_fast", "1 update per pane per 3s");
  const screen = { agent: s.agent, text: s.text, cols: s.cols, rows: s.rows, busy: s.busy === true };
  await d.broadcaster.send("screens", "screen", { address, screen, at: new Date(d.now()).toISOString() });
  return json(204);
});
