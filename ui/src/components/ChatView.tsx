import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Address, MessageType, StoredMessage } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { clockTime, involves, userOf } from "../lib.ts";
import { findSession, myChats } from "../store.ts";
import { Addr, Avatar, Skeleton, StatusDot, useApp } from "./bits.tsx";
import { MessageItem } from "./Message.tsx";

const GROUP_MS = 3 * 60_000;

export function useHistory(address: Address | null) {
  const { state, dispatch, transport } = useApp();
  const status = address ? state.history[address] : undefined;
  const live = state.conn === "connected";
  useEffect(() => {
    if (!address || status === "ready" || status === "loading" || status === "more" || !live) return;
    dispatch({ type: "history", address, status: "loading" });
    transport
      .messages({ address, limit: 100 })
      .then((messages) => dispatch({ type: "history", address, status: messages.length >= 100 ? "more" : "ready", messages }))
      .catch(() => dispatch({ type: "history", address, status: "error" }));
  }, [address, status, live, dispatch, transport]);

  const messages = useMemo(() => {
    if (!address) return [];
    // context_update envelopes belong in the "You" inbox only (agent chats get the activity strip).
    // The hub fans one context write out as a context_update to every "<user>/*"; keep our own copy.
    const inbox = address === `${state.me}/${HUMAN_AGENT}`;
    return Object.values(state.messages)
      .filter((m) => involves(m, address))
      .filter((m) => m.type !== "context_update" || (inbox && m.to === `${state.me}/*`))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [state.messages, address, state.me]);

  const loadEarlier = () => {
    if (!address || !messages.length) return;
    dispatch({ type: "history", address, status: "loading" });
    transport
      .messages({ address, limit: 100, before: messages[0].timestamp })
      .then((older) => dispatch({ type: "history", address, status: older.length >= 100 ? "more" : "ready", messages: older }))
      .catch(() => dispatch({ type: "history", address, status: "error" }));
  };
  return { messages, status, loadEarlier };
}

export function MessageList({ address, compact, onReply }: { address: Address; compact?: boolean; onReply?(m: StoredMessage): void }) {
  const { state } = useApp();
  const { messages, status, loadEarlier } = useHistory(address);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, address]);
  useEffect(() => {
    stick.current = true;
  }, [address]);

  const onScroll = () => {
    const el = scroller.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="msglist" ref={scroller} onScroll={onScroll} aria-live="polite">
      {status === "more" && (
        <button className="load-earlier" onClick={loadEarlier}>
          Load earlier messages
        </button>
      )}
      {(status === "loading" || (status === undefined && state.conn !== "connected")) && messages.length === 0 && (
        <div className="pad">
          <Skeleton lines={4} />
        </div>
      )}
      {status === "error" && <div className="empty">Couldn't load history from the hub. New messages still appear live.</div>}
      {(status === "ready" || status === "more") && messages.length === 0 && (
        <div className="empty">
          <strong>No messages yet.</strong>
          <span>{compact ? "This session hasn't sent or received anything." : "Send a task or a note below to get things moving."}</span>
        </div>
      )}
      {groupRuns(messages).map((run) =>
        run.length >= FOLD_MIN && isSystem(run[0]) ? (
          <SysFold key={run[0].id} run={run} />
        ) : (
          run.map((m) => {
            const i = messages.indexOf(m);
            const prev = messages[i - 1];
            const continued = !!prev && prev.from === m.from && prev.to === m.to && !isSystem(prev) && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < GROUP_MS;
            return (
              <MessageItem
                key={m.id}
                m={m}
                continued={continued}
                compact={compact}
                onReply={onReply}
                replyTo={m.reply_to ? state.messages[m.reply_to] : undefined}
              />
            );
          })
        ),
      )}
    </div>
  );
}

const FOLD_MIN = 3;
const isSystem = (m: StoredMessage) => m.type === "status" || m.type === "context_update";

/** Splits the list into runs: consecutive system rows together, every other message on its own. */
function groupRuns(ms: StoredMessage[]): StoredMessage[][] {
  const runs: StoredMessage[][] = [];
  for (const m of ms) {
    const last = runs[runs.length - 1];
    if (last && isSystem(m) && isSystem(last[0])) last.push(m);
    else runs.push([m]);
  }
  return runs;
}

function SysFold({ run }: { run: StoredMessage[] }) {
  const [open, setOpen] = useState(false);
  const ctx = run.filter((m) => m.type === "context_update").length;
  const label =
    ctx === run.length ? `${run.length} context updates` : ctx === 0 ? `${run.length} status changes` : `${run.length} updates`;
  return (
    <div className={`sysfold ${open ? "open" : ""}`}>
      <button className="sysline sysfold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev" aria-hidden>›</span>
        <span>{label}</span>
        <time>
          {clockTime(run[0].timestamp)}–{clockTime(run[run.length - 1].timestamp)}
        </time>
      </button>
      {open && run.map((m) => <MessageItem key={m.id} m={m} continued={false} />)}
    </div>
  );
}

const TYPES: MessageType[] = ["chat", "task", "result"];

function Composer({ address, replyTo, clearReply }: { address: Address; replyTo: StoredMessage | null; clearReply(): void }) {
  const { state, transport } = useApp();
  const me = state.me!;
  const own = myChats(state).filter((a) => a !== `${me}/${HUMAN_AGENT}`);
  const remoteOrchs = Object.values(state.users)
    .filter((u) => u.user !== me)
    .flatMap((u) => u.sessions.filter((s) => s.kind === "orchestrator").map((s) => s.address));

  const defaultTo = address === `${me}/${HUMAN_AGENT}` ? own[0] ?? "*" : address;
  const [to, setTo] = useState<Address>(defaultTo);
  const [type, setType] = useState<MessageType>("chat");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTo(defaultTo), [defaultTo]);
  useEffect(() => {
    if (replyTo) {
      setTo(replyTo.from);
      if (replyTo.type === "task") setType("result");
      ta.current?.focus();
    }
  }, [replyTo]);

  const options = new Set<Address>([...own, ...remoteOrchs, "*", to]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr("");
    try {
      await transport.send({ from_agent: HUMAN_AGENT, to, type, body, reply_to: replyTo?.id ?? null });
      setText("");
      clearReply();
    } catch (e) {
      setErr(`Not sent: ${(e as Error).message}. Your text is still here.`);
    } finally {
      setBusy(false);
      ta.current?.focus();
    }
  };

  const remote = to === "*" || userOf(to) !== me;
  return (
    <div className="composer">
      {replyTo && (
        <div className="replying">
          Replying to <Addr a={replyTo.from} me={me} />
          <button className="link" onClick={clearReply}>
            Cancel
          </button>
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        rows={2}
        placeholder={`Message ${to === "*" ? "everyone" : to}… Markdown works.`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        aria-label="Message"
      />
      <div className="composer-bar">
        <label className="sel">
          <span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <optgroup label="Your agents">
              {[...options].filter((a) => a !== "*" && userOf(a) === me).map((a) => <option key={a} value={a}>{a}</option>)}
            </optgroup>
            <optgroup label="Other users">
              {[...options].filter((a) => a !== "*" && userOf(a) !== me).map((a) => <option key={a} value={a}>{a}</option>)}
            </optgroup>
            <optgroup label="Broadcast">
              <option value="*">* everyone</option>
            </optgroup>
          </select>
        </label>
        <label className="sel">
          <span>As</span>
          <select value={type} onChange={(e) => setType(e.target.value as MessageType)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {remote && <span className="hint" title="Messages to other users arrive as requests; they decide whether to act.">Arrives as a request</span>}
        {err && <span className="err">{err}</span>}
        <span className="grow" />
        <kbd className="kbd">⌘↵</kbd>
        <button className="btn btn-primary" onClick={send} disabled={!text.trim() || busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

export function ChatView() {
  const { state } = useApp();
  const address = state.selected;
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  useEffect(() => setReplyTo(null), [address]);

  if (!state.snapshotReady) {
    return (
      <section className="center">
        <div className="center-head"><Skeleton lines={1} /></div>
        <div className="pad"><Skeleton lines={6} /></div>
      </section>
    );
  }
  if (!address) {
    return (
      <section className="center">
        <div className="empty big">
          <strong>Pick a chat on the left.</strong>
          <span>Or press ⌘K to jump to one.</span>
        </div>
      </section>
    );
  }
  const s = findSession(state, address);
  const isMe = address === `${state.me}/${HUMAN_AGENT}`;
  return (
    <section className="center">
      <div className="center-head">
        <Avatar user={userOf(address)} size={30} />
        <div className="ch-title">
          <div className="ch-name">
            {isMe ? "You" : <Addr a={address} me={state.me} />}
            {s && <StatusDot status={s.status} />}
            {s && <span className="ch-status">{s.status}</span>}
          </div>
          <div className="ch-task">{isMe ? "Everything sent to or from you, including broadcasts" : s?.task || "No current task"}</div>
        </div>
      </div>
      <MessageList address={address} onReply={setReplyTo} />
      <Composer address={address} replyTo={replyTo} clearReply={() => setReplyTo(null)} />
    </section>
  );
}
