// Types into ONE of the signed-in user's own panes (contracts/input.md), from the zoomed terminal.
// Same path and rules as the CommandBar; only ever shown for your own team.
import { useEffect, useRef, useState } from "react";
import { PANE_INPUT_MAX, type PaneInputStatus } from "../lib.ts";
import { useApp } from "./bits.tsx";

const POLL_MS = 500;
const POLL_FOR_MS = 10_000;
const LABEL: Record<string, string> = { sent: "sent", "skipped: prompt_open": "skipped: a yes/no prompt is open", "skipped: no_pane": "skipped: pane not running" };

export function PaneInput({ agent, label }: { agent: string; label: string }) {
  const { transport } = useApp();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState<{ id: string; status: PaneInputStatus | null; timedOut: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (!run || run.timedOut || (run.status && run.status.state !== "pending")) return;
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

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr(null);
    const r = await transport.paneInput({ agents: [agent], text: body, submit: true });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    setRun({ id: r.id, status: { id: r.id, state: "pending" }, timedOut: false });
    setText("");
    input.current?.focus();
  };

  const result = run?.status?.results?.[agent];
  const note = err ?? (result ? LABEL[result] ?? result : run?.timedOut ? "no answer from the bridge after 10s" : run ? "typing…" : null);
  const kind = err || run?.timedOut || (result && result.startsWith("failed")) ? "fail" : result?.startsWith("skipped") ? "skip" : result ? "ok" : "wait";

  return (
    <div className="cmdbar tinput" onClick={(e) => e.stopPropagation()}>
      <div className="cmd-row">
        <label className="cmd-field">
          <span className="cmd-glyph" aria-hidden>❯</span>
          <input
            ref={input}
            value={text}
            maxLength={PANE_INPUT_MAX}
            placeholder={`Type into ${label}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            aria-label={`Text to type into ${label}`}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button className="btn btn-primary cmd-send" onClick={send} disabled={!text.trim() || busy}>
          {busy ? "Sending…" : "Send"} <kbd className="kbd">↵</kbd>
        </button>
      </div>
      {note && (
        <div className={`cmd-results ${err ? "has-error" : ""}`} role="status">
          <span className={`rchip rchip-${kind}`}>
            <b>{label}</b> {note}
          </span>
        </div>
      )}
    </div>
  );
}
