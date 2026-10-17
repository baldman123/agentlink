import { useCallback, useMemo, useRef, useState } from "react";
import type { StoredMessage } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { relTime } from "../lib.ts";
import { bossPending, findSession, inBossThread } from "../store.ts";
import { Skeleton, StatusDot, useApp, useNow } from "./bits.tsx";
import { AttachButton, AttachmentChips, useAttachments } from "./Attachments.tsx";
import { MessageList, useSend } from "./ChatView.tsx";

/**
 * The pinned BOSS panel: your chat with your own orchestrator (<me>/human <-> <me>/orchestrator),
 * its status, and a one-line composer that always sends to it. Each message you send shows
 * "waiting for the boss…" until the boss sends something back with that message's id as reply_to.
 */
export function OrchestratorPanel() {
  const { state, openTerminal } = useApp();
  const now = useNow(10_000); // so "waiting" expires and "last active" stays fresh
  const me = state.me;
  const pending = useMemo(() => bossPending(state, now), [state.messages, state.me, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter = useCallback((m: StoredMessage) => inBossThread(me, m), [me]);
  const noteFor = useCallback(
    (m: StoredMessage) => (pending[m.id] ? <span className="boss-wait" role="status">waiting for the boss<span className="boss-wait-dots" aria-hidden /></span> : null),
    [pending],
  );

  if (!state.snapshotReady || !me) return <div className="pad"><Skeleton lines={6} /></div>;
  const bossAddr = `${me}/orchestrator`;
  const boss = findSession(state, bossAddr);
  const status = boss?.status ?? "offline";
  return (
    <div className="bosspanel">
      <header className="bp-head">
        <span className="bp-mark" aria-hidden>◆</span>
        <div className="bp-title">
          <div className="bp-name">
            BOSS
            <StatusDot status={boss ? status : "offline"} />
            <span className="bp-status">{boss ? status : "not running"}</span>
          </div>
          <div className="bp-task" title={boss?.task || undefined}>
            {boss ? boss.task || "No current task" : "No orchestrator on this laptop yet. Messages wait for it."}
            {boss && <span className="bp-time"> · {relTime(boss.last_activity, now)}</span>}
          </div>
        </div>
        <button className="link bp-pane" onClick={() => openTerminal(bossAddr)} disabled={!boss} title={boss ? "Open the boss's screen in Terminals" : "The boss isn't running"}>
          show pane
        </button>
      </header>
      <MessageList
        address={`${me}/${HUMAN_AGENT}`}
        compact
        filter={filter}
        noteFor={noteFor}
        emptyText="Tell the boss what you want done. It splits the work across the workers and reports back here."
      />
      <BossComposer />
    </div>
  );
}

/** Always to <me>/orchestrator, always a chat from you. Enter sends, Shift+Enter for a new line. */
function BossComposer() {
  const { state } = useApp();
  const { send, busy, err } = useSend();
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const files = useAttachments(false); // the boss is on this laptop
  const ready = (!!text.trim() || files.ids.length > 0) && !files.blocker;
  const go = async () => {
    if (!ready || busy) return;
    if (await send({ to: `${state.me}/orchestrator`, type: "chat", body: text, attachments: files.ids })) {
      setText("");
      files.clear();
    }
    ta.current?.focus();
  };
  return (
    <div className={`bp-composer ${files.dragging ? "drop-on" : ""}`} {...files.dropHandlers}>
      {files.dragging && <div className="drop-hint" aria-hidden>Drop files for the boss</div>}
      <AttachmentChips items={files.items} onRemove={files.remove} crossesHub={false} />
      <AttachButton onFiles={files.add} className="bp-attach" />
      <textarea
        ref={ta}
        value={text}
        rows={1}
        placeholder="Message the boss…"
        onPaste={files.onPaste}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            go();
          }
        }}
        aria-label="Message the boss"
      />
      <button className="btn btn-primary" onClick={go} disabled={!ready || busy}>{busy ? "…" : "Send"}</button>
      {err && <div className="err bp-err">{err}</div>}
      {!err && (files.blocker || files.notice) && <div className="hint bp-err">{files.blocker || files.notice}</div>}
    </div>
  );
}
