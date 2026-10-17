// "Your calls": the yes/no decisions the claude4 boss passes to the team's owner. They start in the claude4 state
// dir (~/.claude4/<session>: requests/<id>.json with needsBryant, questions/<id>.json), the same inbox the boss
// circle reads. The daemon (daemon/src/calls.ts) mirrors the pending ones to the website and delivers answers made
// there back through `c4 decide` / `c4 answer`, exactly as the boss circle does.
//
// Sync is full-state: every PUT /api/calls/sync carries all of this person's pending calls. The website drops any
// row the daemon no longer lists (answered on the boss circle, or delivered), and replies with the answers made on
// the site that the daemon hasn't delivered yet. Rows are service-role only; browsers read GET /api/calls.

export type CallKind = "permission" | "question";
export type CallChoice = "yes" | "no";
export type CallState = "pending" | "answering"; // answering = answered on the site, not yet delivered into claude4

/** What the daemon uploads for one pending call. */
export interface CallUpload {
  id: string; // the claude4 id (e.g. "0jww8", "q07579")
  kind: CallKind;
  summary: string; // ONE plain-English sentence: what will happen, why it matters, what Yes does. Shown first.
  details: string; // the raw command, or the question's options/context, behind the "details" toggle
  why: string | null; // claude4's reason for asking, when it gave one
  from: string; // "the boss", "quarter 2"
  asked_at: string; // ISO 8601
}

export interface CallAnswer {
  choice: CallChoice | null; // null only for a question answered in free text (the note is the answer)
  note: string; // "" when none
}

/** GET /api/calls item. */
export interface Call extends CallUpload {
  state: CallState;
  answer: CallAnswer | null;
  answered_at: string | null;
}

/** GET /api/calls */
export interface CallListResponse {
  calls: Call[];
}

/** PUT /api/calls/sync (daemon) */
export interface CallSyncRequest {
  calls: CallUpload[];
}
export interface CallSyncResponse {
  answers: (CallAnswer & { id: string })[];
}

export const CALL_ID_RE = /^[A-Za-z0-9]{2,20}$/;
export const CALL_NOTE_MAX = 500;
export const CALL_SUMMARY_MAX = 400;
export const CALL_DETAILS_MAX = 4000;
export const CALLS_MAX = 50; // per person per sync

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

/** A sanitized upload, or null when it can't be shown (no id, no plain-English summary). */
export function validCallUpload(v: unknown): CallUpload | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== "string" || !CALL_ID_RE.test(c.id)) return null;
  if (c.kind !== "permission" && c.kind !== "question") return null;
  const summary = str(c.summary, CALL_SUMMARY_MAX)?.trim();
  if (!summary) return null;
  const asked = typeof c.asked_at === "string" && !Number.isNaN(Date.parse(c.asked_at)) ? new Date(c.asked_at).toISOString() : null;
  if (!asked) return null;
  return {
    id: c.id,
    kind: c.kind,
    summary,
    details: str(c.details, CALL_DETAILS_MAX) ?? "",
    why: str(c.why, CALL_SUMMARY_MAX) || null,
    from: str(c.from, 64) || "the team",
    asked_at: asked,
  };
}

/**
 * The answer body of POST /api/calls/:id/answer, or null: { choice: "yes"|"no", note? } for any call, or
 * { note } alone (free text) for a question. A permission request always needs a choice.
 */
export function validCallAnswer(v: unknown, kind: CallKind): CallAnswer | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return null;
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > CALL_NOTE_MAX) return null;
  if (b.choice === "yes" || b.choice === "no") return { choice: b.choice, note };
  if ((b.choice === undefined || b.choice === null) && kind === "question" && note) return { choice: null, note };
  return null;
}

/** What `c4 decide` / `c4 answer` gets for a site answer (the same words the boss circle would pass). */
export function c4Args(id: string, kind: CallKind, a: CallAnswer): string[] {
  if (kind === "permission") return ["decide", id, a.choice === "yes" ? "approve" : "deny", ...(a.note ? [a.note] : [])];
  const word = a.choice === "yes" ? "Yes" : a.choice === "no" ? "No" : "";
  return ["answer", id, word && a.note ? `${word} — ${a.note}` : word || a.note];
}
