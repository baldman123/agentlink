"use client";
// "Your calls": the yes/no decisions the boss passes to you (contracts/calls.ts). useCalls polls the list for the
// header badge and the panel; CallsPanel shows one card per call. A call you answer reads "sending to your laptop"
// until the daemon delivers it, then shows as answered for a moment and leaves.
import { useCallback, useEffect, useRef, useState } from "react";
import { CALL_NOTE_MAX } from "../../contracts/calls.ts";
import { ApiError, signOut } from "../lib/client/api.ts";
import { answerCall, listCalls, type Call, type CallChoice } from "../lib/client/calls.ts";

const POLL_MS = 5_000;
const LINGER_MS = 4_000; // how long an answered card stays before it leaves

/** A card on screen: a live call, or one that just left the list and is about to disappear. */
export interface CallItem {
  call: Call;
  gone?: "answered" | "elsewhere";
}

export interface Calls {
  items: CallItem[] | null; // null while the first load is in flight
  failed: boolean;
  pending: number; // the badge: calls still waiting for a yes or no
  reload(): void;
  answer(id: string, choice: CallChoice | null, note: string): Promise<string | null>; // an error to show, or null
}

export function useCalls(): Calls {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [gone, setGone] = useState<CallItem[]>([]);
  const [failed, setFailed] = useState(false);
  const known = useRef(new Map<string, Call>());
  const stopped = useRef(false);

  const leave = useCallback((items: CallItem[]) => {
    if (!items.length) return;
    setGone((g) => [...g.filter((x) => !items.some((i) => i.call.id === x.call.id)), ...items]);
    setTimeout(() => setGone((g) => g.filter((x) => !items.some((i) => i.call.id === x.call.id))), LINGER_MS);
  }, []);

  const take = useCallback(
    (list: Call[]) => {
      const ids = new Set(list.map((c) => c.id));
      // a call that left the list was delivered (if it had an answer) or settled on the boss circle
      leave(
        [...known.current.values()]
          .filter((c) => !ids.has(c.id))
          .map((c) => ({ call: c, gone: c.answer ? ("answered" as const) : ("elsewhere" as const) })),
      );
      known.current = new Map(list.map((c) => [c.id, c]));
      setCalls(list);
    },
    [leave],
  );

  const reload = useCallback(async () => {
    if (stopped.current) return;
    try {
      take((await listCalls()).calls);
      setFailed(false);
    } catch (e) {
      // signed out: stop asking; the app's own session handling shows the sign-in page (with the reason, if revoked)
      if (e instanceof ApiError && e.signedOut) return void (stopped.current = true);
      if (e instanceof ApiError && e.status === 404) return take([]); // this deployment has no calls route yet
      setFailed(true);
    }
  }, [take]);

  useEffect(() => {
    void reload();
    const tick = () => document.visibilityState === "visible" && void reload();
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [reload]);

  const answer = useCallback(
    async (id: string, choice: CallChoice | null, note: string) => {
      const before = known.current.get(id);
      if (!before) return null;
      const sending: Call = { ...before, state: "answering", answer: { choice, note }, answered_at: new Date().toISOString() };
      known.current.set(id, sending);
      setCalls((l) => l?.map((c) => (c.id === id ? sending : c)) ?? l);
      try {
        const { call } = await answerCall(id, choice, note);
        if (known.current.has(id)) {
          known.current.set(id, call);
          setCalls((l) => l?.map((c) => (c.id === id ? call : c)) ?? l);
        }
        return null;
      } catch (e) {
        if (e instanceof ApiError && e.signedOut) return void signOut(e.code === "revoked" ? "revoked" : undefined), null;
        if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
          // someone already settled it (the boss circle, another tab): show that, then drop it
          known.current.delete(id);
          setCalls((l) => l?.filter((c) => c.id !== id) ?? l);
          leave([{ call: before, gone: "elsewhere" }]);
          return null;
        }
        known.current.set(id, before);
        setCalls((l) => l?.map((c) => (c.id === id ? before : c)) ?? l);
        return e instanceof ApiError && e.code === "bad_answer" ? "That answer wasn't accepted. Check the note (500 characters at most) and try again." : "Couldn't send your answer. Check your connection and try again.";
      }
    },
    [leave],
  );

  const items =
    calls === null
      ? null
      : [...calls.map((call) => ({ call })), ...gone.filter((g) => !calls.some((c) => c.id === g.call.id))].sort((a, b) =>
          a.call.asked_at.localeCompare(b.call.asked_at),
        );
  const pending = calls?.filter((c) => c.state === "pending").length ?? 0;
  return { items, failed, pending, reload: () => void reload(), answer };
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const word = (c: CallChoice) => (c === "yes" ? "Yes" : "No");

/** Does a question read as yes/no? The contract has no structured options (details is free text), so: it opens with
 *  an auxiliary verb ("Should we…", "Can I…"), or the summary or details mark it "(yes/no)". */
const YES_NO_START = /^(should|can|could|do|does|did|is|are|was|were|will|would|shall|may|might|has|have)\b/i;
const YES_NO_MARK = /\(?\s*yes\s*\/\s*no\s*\)?\s*\??\s*$/i;
export function readsYesNo(summary: string, details: string): boolean {
  const s = summary.trim();
  return YES_NO_START.test(s) || YES_NO_MARK.test(s) || /\byes\s*\/\s*no\b/i.test(details);
}

function CallCard({ item, now, answer }: { item: CallItem; now: number; answer: Calls["answer"] }) {
  const { call, gone } = item;
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const boss = /boss/i.test(call.from);
  const locked = call.state !== "pending" || !!gone;
  const chosen = call.answer?.choice;
  const qid = `call-q-${call.id}`;

  const isQuestion = call.kind === "question";
  const yesNo = !isQuestion || readsYesNo(call.summary, call.details); // permissions are always yes/no
  const open = !yesNo; // an open question: the answer box is the whole answer
  const pick = async (choice: CallChoice | null) => {
    if (locked || (!choice && !note.trim())) return;
    setError(null);
    setError(await answer(call.id, choice, note.trim()));
  };

  return (
    <article className={`call${gone ? " call-gone" : ""}${locked ? " call-locked" : ""}`} aria-labelledby={qid} data-testid={`call-${call.id}`}>
      <div className="call-meta">
        <span className={`call-from${boss ? " is-boss" : ""}`}>
          <span className="call-mark" aria-hidden>
            {boss ? "◆" : call.from.replace(/^\D*/, "").slice(0, 2) || cap(call.from).charAt(0)}
          </span>
          {cap(call.from)} asks
        </span>
        <time dateTime={call.asked_at} title={new Date(call.asked_at).toLocaleString()}>
          {ago(call.asked_at, now)}
        </time>
        <span className={`tag call-kind call-kind-${call.kind}`}>{call.kind === "permission" ? "needs your OK" : "question"}</span>
      </div>

      <h3 className="call-q" id={qid}>
        {call.summary}
      </h3>
      {call.why && <p className="call-why">{call.why}</p>}

      {yesNo && (
        <div className="call-actions" role="group" aria-label="Your answer">
          <button className="btn call-btn call-yes" disabled={locked} aria-pressed={chosen === "yes"} onClick={() => void pick("yes")}>
            Yes
          </button>
          <button className="btn call-btn call-no" disabled={locked} aria-pressed={chosen === "no"} onClick={() => void pick("no")}>
            No
          </button>
        </div>
      )}

      {gone === "answered" ? (
        <div className="call-status call-status-done" role="status">
          <span aria-hidden>✓</span>
          <span>
            Answered{chosen ? <> <strong>{word(chosen)}</strong></> : ""}. Your laptop passed it on to {call.from}.
          </span>
        </div>
      ) : gone === "elsewhere" ? (
        <div className="call-status call-status-done" role="status">
          <span aria-hidden>✓</span>
          <span>Already answered somewhere else (the boss circle or another tab).</span>
        </div>
      ) : call.state === "answering" ? (
        <div className="call-status" role="status">
          <span className="call-spin" aria-hidden />
          <span>
            {chosen ? <>You said <strong>{word(chosen)}</strong>.</> : "Answer saved."} Sending to your laptop…
          </span>
        </div>
      ) : (
        <div className={`call-note${open ? " call-note-main" : ""}`}>
          <label className="sr-only" htmlFor={`call-note-${call.id}`}>
            {open ? "Your answer" : isQuestion ? "Your answer or a note" : "Note (optional)"}
          </label>
          <textarea
            id={`call-note-${call.id}`}
            value={note}
            maxLength={CALL_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (open && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void pick(null);
              }
            }}
            rows={open ? 2 : 1}
            placeholder={
              open ? "Type your answer" : isQuestion ? "Or type your own answer (also sent as a note with Yes/No)" : "Add a note (optional), sent with your answer"
            }
          />
          {isQuestion && (
            <button className={`btn call-send${open ? " btn-primary" : ""}`} disabled={!note.trim()} onClick={() => void pick(null)}>
              Send
            </button>
          )}
        </div>
      )}
      {call.answer?.note && (call.state === "answering" || gone) && <p className="call-sent-note">{chosen ? "Your note" : "Your answer"}: {call.answer.note}</p>}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      {call.details && (
        <details className="call-details">
          <summary>Details</summary>
          <pre>{call.details}</pre>
        </details>
      )}
    </article>
  );
}

/** The popup under the Calls button. It floats over the page and closes on Close, Escape, or a click outside it;
 *  the buttons that toggle it carry data-calls-toggle so a click on them toggles instead of counting as outside. */
export function CallsPanel({ calls, close }: { calls: Calls; close(): void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const { items, failed, pending } = calls;

  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  // close and put focus back on whatever opened it (the header button when opened by ?view=calls)
  const dismiss = useCallback(() => {
    const back = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>("[data-testid='calls-btn']");
    back?.focus();
    closeRef.current();
  }, []);
  useEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) dismiss();
    };
    // a click outside closes it without pulling focus back, so the thing clicked keeps it
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || t.closest("[data-calls-toggle]")) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [dismiss]);

  return (
    <section className="calls calls-pop" role="dialog" aria-label="Your calls" tabIndex={-1} ref={ref} data-testid="calls-pop">
      <header className="calls-head">
        <div className="ch-title">
          <h2 className="ch-name" id="calls-h">
            Your calls
          </h2>
          <div className="ch-task">{pending ? `${pending} waiting for your yes or no` : "Yes/no decisions your team needs from you"}</div>
        </div>
        <span className="grow" />
        <button className="btn btn-ghost calls-close" onClick={dismiss}>
          Close
        </button>
      </header>
      <div className="calls-list">
        {items === null ? (
          failed ? (
            <div className="empty" role="alert">
              <strong>Can&apos;t load your calls.</strong>
              <span>Check your connection, then try again.</span>
              <button className="btn" onClick={calls.reload}>
                Try again
              </button>
            </div>
          ) : (
            <div className="skeleton" aria-busy="true">
              <span style={{ width: "80%" }} />
              <span style={{ width: "55%" }} />
            </div>
          )
        ) : items.length === 0 ? (
          <div className="empty calls-empty" data-testid="calls-empty">
            <strong>Nothing needs you right now.</strong>
            <span>When the boss needs a yes or no from you, the question shows up here.</span>
          </div>
        ) : (
          <>
            {failed && (
              <div className="calls-stale" role="status">
                Can&apos;t reach agentlink; this list may be out of date.
              </div>
            )}
            {items.map((item) => (
              <CallCard key={item.call.id} item={item} now={now} answer={calls.answer} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
