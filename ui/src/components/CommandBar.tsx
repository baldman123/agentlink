// Types into this laptop's own claude4 panes (contracts/input.md). Trusted local input: it only ever
// targets the signed-in user's agents, goes to the local daemon, and never crosses the hub.
import { useEffect, useRef, useState } from "react";
import type { UserPresence } from "../../../contracts/index.ts";
import { PANE_INPUT_MAX, saveStorage, type PaneInputStatus, type PaneResult } from "../lib.ts";
import { cutoffKey } from "../store.ts";
import { AttachButton, AttachmentChips, useAttachments } from "./Attachments.tsx";
import { useApp } from "./bits.tsx";

const PANES = [
  { agent: "orchestrator", label: "Boss" },
  { agent: "worker-1", label: "W1" },
  { agent: "worker-2", label: "W2" },
  { agent: "worker-3", label: "W3" },
  { agent: "worker-4", label: "W4" },
] as const;
const POLL_MS = 500;
const POLL_FOR_MS = 10_000;

type Run = {
  id: string | null; // null until the daemon accepted it
  text: string;
  agents: string[];
  status: PaneInputStatus | null;
  timedOut: boolean;
  error: string | null;
};

const RESULT_LABEL: Record<string, string> = {
  sent: "sent",
  "skipped: prompt_open": "skipped: prompt open",
  "skipped: no_pane": "skipped: no pane",
};
const resultKind = (r: PaneResult) => (r === "sent" ? "ok" : r.startsWith("skipped") ? "skip" : "fail");

export function CommandBar({ team }: { team: UserPresence }) {
  const { transport, dispatch } = useApp();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(PANES.map((p) => p.agent)));
  const [run, setRun] = useState<Run | null>(null);
  const [posting, setPosting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [clearHistory, setClearHistory] = useState(false);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const input = useRef<HTMLInputElement>(null);
  const has = new Set(team.sessions.map((s) => s.agent));
  const all = checked.size === PANES.length;
  const targets = PANES.filter((p) => checked.has(p.agent)).map((p) => p.agent);

  // poll the one status endpoint until every pane has a result, for up to 10s (input.md)
  useEffect(() => {
    if (!run?.id || run.timedOut || (run.status && run.status.state !== "pending")) return;
    const started = Date.now();
    const id = run.id;
    const t = setInterval(async () => {
      const st = await transport.paneInputStatus(id);
      const expired = Date.now() - started > POLL_FOR_MS;
      setRun((r) => (r && r.id === id ? { ...r, status: st ?? r.status, timedOut: expired && (!st || st.state === "pending") } : r));
      if (expired || (st && st.state !== "pending")) clearInterval(t);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [run?.id, transport]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (body: string) => {
    if (!body || posting || !targets.length) return false;
    if (body.length > PANE_INPUT_MAX) {
      setRun({ id: null, text: body, agents: targets, status: null, timedOut: false, error: `That's ${body.length} characters; the limit is ${PANE_INPUT_MAX}.` });
      return false;
    }
    setPosting(true);
    const r = await transport.paneInput({ agents: targets, text: body, submit: true });
    setPosting(false);
    if (!r.ok) {
      setRun({ id: null, text: body, agents: targets, status: null, timedOut: false, error: r.message });
      return false;
    }
    setRun({ id: r.id, text: body, agents: targets, status: { id: r.id, state: "pending" }, timedOut: false, error: null });
    return true;
  };

  const files = useAttachments(false); // own panes: the files are already on this laptop
  const send = async () => {
    if (files.blocker) return;
    const typed = text.trim();
    // one line, so the Enter after it submits everything: "look at this [attached: /…/shot.png]"
    const body = [typed, ...files.paths.map((p) => `[attached: ${p}]`)].filter(Boolean).join(" ");
    if (await submit(body)) {
      if (typed) history.current = [typed, ...history.current.filter((h) => h !== typed)].slice(0, 30);
      histIdx.current = -1;
      setText("");
      files.clear();
    }
    input.current?.focus();
  };
  const ready = (!!text.trim() || files.paths.length > 0) && !files.blocker && targets.length > 0 && !posting;

  const reset = async () => {
    setConfirm(false);
    if (clearHistory) {
      const at = new Date().toISOString();
      saveStorage(cutoffKey(team.user), at);
      dispatch({ type: "history.cutoff", at });
    }
    await submit("/clear");
  };

  const toggle = (agent: string) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(agent)) n.delete(agent);
      else n.add(agent);
      return n;
    });

  return (
    <div className={`cmdbar ${files.dragging ? "drop-on" : ""}`} aria-label={`Type into ${team.user}'s panes`} {...files.dropHandlers}>
      {files.dragging && <div className="drop-hint" aria-hidden>Drop files to type their paths into the panes</div>}
      <div className="cmd-row">
        <label className="cmd-field">
          <span className="cmd-glyph" aria-hidden>❯</span>
          <input
            ref={input}
            value={text}
            onPaste={files.onPaste}
            maxLength={PANE_INPUT_MAX}
            placeholder={targets.length ? `Type into ${all ? "every pane" : targets.map(labelOf).join(", ")}…` : "Pick at least one pane"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "ArrowUp" && history.current.length) {
                e.preventDefault();
                histIdx.current = Math.min(history.current.length - 1, histIdx.current + 1);
                setText(history.current[histIdx.current]);
              } else if (e.key === "ArrowDown" && histIdx.current >= 0) {
                e.preventDefault();
                histIdx.current -= 1;
                setText(histIdx.current < 0 ? "" : history.current[histIdx.current]);
              }
            }}
            aria-label="Text to type into the checked panes"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="cmd-targets" role="group" aria-label="Panes to type into">
          {PANES.map((p) => (
            <label key={p.agent} className={`cmd-chk ${checked.has(p.agent) ? "on" : ""} ${has.has(p.agent) ? "" : "absent"}`} title={has.has(p.agent) ? `${team.user}/${p.agent}` : `${team.user}/${p.agent} is not running`}>
              <input type="checkbox" checked={checked.has(p.agent)} onChange={() => toggle(p.agent)} />
              <span>{p.label}</span>
            </label>
          ))}
          <label className={`cmd-chk cmd-all ${all ? "on" : ""}`}>
            <input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(PANES.map((p) => p.agent)))} />
            <span>All</span>
          </label>
        </div>
        <AttachButton onFiles={files.add} className="cmd-attach" />
        <button className="btn btn-primary cmd-send" onClick={send} disabled={!ready}>
          {posting ? "Sending…" : "Send"} <kbd className="kbd">↵</kbd>
        </button>
        <button className="btn cmd-reset" onClick={() => { setClearHistory(false); setConfirm(true); }} disabled={!targets.length || posting}>
          Reset chats
        </button>
      </div>
      <AttachmentChips items={files.items} onRemove={files.remove} crossesHub={false} />
      {(files.blocker || files.notice) && files.items.length > 0 && <div className="cmd-hint att-hint">{files.blocker || files.notice}</div>}
      {run && <Results run={run} onDismiss={() => setRun(null)} />}
      {confirm && (
        <div className="scrim" onMouseDown={() => setConfirm(false)}>
          <div
            className="dialog"
            role="alertdialog"
            aria-labelledby="reset-title"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === "Escape" && setConfirm(false)}
          >
            <h2 id="reset-title">Reset {targets.length === 1 ? "this chat" : `${targets.length} chats`}?</h2>
            <p>
              This types <code>/clear</code> into each pane below, which wipes that Claude's conversation. Work on disk is untouched.
            </p>
            <ul className="dialog-list">
              {targets.map((a) => {
                const s = team.sessions.find((x) => x.agent === a);
                return (
                  <li key={a}>
                    <span className="dl-name">{labelOf(a)}</span>
                    <span className="dl-addr">{team.user}/{a}</span>
                    <span className="dl-task">{s ? s.task || s.status : "not running"}</span>
                  </li>
                );
              })}
            </ul>
            <label className="dialog-check">
              <input type="checkbox" checked={clearHistory} onChange={(e) => setClearHistory(e.target.checked)} />
              <span>Also clear chat history in this browser <em>(hides earlier messages here; nothing is deleted)</em></span>
            </label>
            <div className="row">
              <span className="grow" />
              <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={reset} autoFocus>
                Reset {targets.length === 1 ? "chat" : `${targets.length} chats`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function labelOf(agent: string) {
  return PANES.find((p) => p.agent === agent)?.label ?? agent;
}

function Results({ run, onDismiss }: { run: Run; onDismiss(): void }) {
  const pending = !run.error && (!run.status || run.status.state === "pending") && !run.timedOut;
  return (
    <div className={`cmd-results ${run.error ? "has-error" : ""}`} role="status">
      <span className="cmd-echo">
        <span className="cmd-glyph" aria-hidden>❯</span> {run.text.length > 60 ? `${run.text.slice(0, 60)}…` : run.text}
      </span>
      {run.error ? (
        <span className="cmd-error">{run.error}</span>
      ) : (
        <span className="cmd-chips">
          {run.agents.map((a) => {
            const r = run.status?.results?.[a];
            const kind = r ? resultKind(r) : run.timedOut ? "fail" : "wait";
            const label = r ? (RESULT_LABEL[r] ?? r.replace(/^failed: /, "failed: ")) : run.timedOut ? "no result" : "typing…";
            return (
              <span key={a} className={`rchip rchip-${kind}`}>
                <b>{labelOf(a)}</b> {label}
              </span>
            );
          })}
          {run.timedOut && <span className="cmd-hint">No answer from the bridge after 10s. Is it running?</span>}
          {run.status?.state === "failed" && !run.status.results && <span className="cmd-hint">The daemon dropped it (no bridge picked it up within 60s).</span>}
        </span>
      )}
      <span className="grow" />
      {!pending && <button className="link" onClick={onDismiss} aria-label="Dismiss result">✕</button>}
    </div>
  );
}
