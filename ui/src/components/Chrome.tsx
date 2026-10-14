import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { agentOf, DAEMON_PORT, relTime } from "../lib.ts";
import type { Activity } from "../store.ts";
import { findSession, myChats } from "../store.ts";
import { Addr, StatusDot, useApp, useNow } from "./bits.tsx";

const CONN_LABEL = { connected: "Connected", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline" } as const;

export function Header({ theme, toggleTheme }: { theme: string; toggleTheme(): void }) {
  const { state, transport } = useApp();
  const host = state.hubUrl ? state.hubUrl.replace(/^https?:\/\//, "") : null;
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden>
          <circle cx="4" cy="7" r="3.2" className="lamp-a" />
          <path d="M7 7 H15" className="wire" />
          <circle cx="18" cy="7" r="3.2" className="lamp-b" />
        </svg>
        <span className="brand-name">agentlink</span>
        {transport.mock && <span className="mock-tag" title="Mock data, not a real hub">mock</span>}
      </div>
      <div className="who">
        {state.me ? <>signed in as <strong>{state.me}</strong></> : "finding your daemon…"}
        <span className="muted"> · daemon :{DAEMON_PORT}</span>
      </div>
      <span className="grow" />
      <div className={`conn conn-${state.conn}`} role="status" title={state.connDetail || undefined}>
        <span className="conn-dot" />
        <span className="conn-label">{CONN_LABEL[state.conn]}</span>
        <span className="conn-host">{state.conn === "offline" && state.connDetail ? state.connDetail : host ? `${state.hubName ?? "hub"} · ${host}` : "no hub yet"}</span>
      </div>
      <button className="btn btn-ghost icon" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
        {theme === "dark" ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map((d) => <line key={d} x1="8" y1="1.6" x2="8" y2="3" transform={`rotate(${d} 8 8)`} />)}</g></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" fill="currentColor" /></svg>
        )}
      </button>
    </header>
  );
}

function ActivityLine({ a, onOpen }: { a: Activity; onOpen?(): void }) {
  const { state } = useApp();
  const now = useNow();
  return (
    <button className={`act act-${a.kind} act-${a.label}`} onClick={onOpen} tabIndex={onOpen ? 0 : -1}>
      {a.kind === "message" && a.from && a.to ? (
        <>
          <Addr a={a.from} me={state.me} />
          <span className="act-wire" aria-hidden><span className="act-lbl">{a.label}</span></span>
          <Addr a={a.to} me={state.me} />
        </>
      ) : (
        <span className="act-text">{a.text}</span>
      )}
      <time>{relTime(a.at, now)}</time>
    </button>
  );
}

/** Signature strip: cross-machine traffic drawn as patch cables between addresses. */
export function ActivityStrip() {
  const { state, openContext, openFeed } = useApp();
  const items = state.activity.slice(0, 12);
  return (
    <div className="strip" aria-label="Cross-machine activity">
      <span className="strip-label">on the wire</span>
      <div className="strip-track">
        {items.length === 0 && <span className="strip-empty">Cross-machine messages and context edits show up here.</span>}
        {items.map((a) => (
          <ActivityLine
            key={a.id}
            a={a}
            onOpen={a.contextKey ? () => openContext(a.contextKey!) : a.to && a.to !== "*" ? () => openFeed(a.to as Address) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

export function Toasts() {
  const { state, dispatch, openContext, openFeed } = useApp();
  const toasts = state.activity.filter((a) => a.toast).slice(0, 4);
  useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dispatch({ type: "toast.done", id: t.id }), 5200));
    return () => timers.forEach(clearTimeout);
  }, [toasts.map((t) => t.id).join(), dispatch]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div className="toast-body">
            {t.kind === "message" && t.from && t.to ? (
              <>
                <Addr a={t.from} me={state.me} /> {t.text} <Addr a={t.to} me={state.me} />
              </>
            ) : (
              <>
                {t.from && <><Addr a={t.from} me={state.me} />: </>}
                {t.text}
              </>
            )}
          </div>
          <div className="toast-actions">
            {t.contextKey && <button className="link" onClick={() => { openContext(t.contextKey!); dispatch({ type: "toast.done", id: t.id }); }}>View</button>}
            {t.kind === "message" && t.to && t.to !== "*" && <button className="link" onClick={() => { openFeed(t.to!); dispatch({ type: "toast.done", id: t.id }); }}>Open</button>}
            <button className="link" aria-label="Dismiss" onClick={() => dispatch({ type: "toast.done", id: t.id })}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Switcher({ close }: { close(): void }) {
  const { state, openFeed } = useApp();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo(() => {
    const mine = myChats(state).map((a) => ({ a, own: true }));
    const others = Object.values(state.users)
      .filter((u) => u.user !== state.me)
      .flatMap((u) => u.sessions.map((s) => ({ a: s.address, own: false })));
    const n = q.trim().toLowerCase();
    return [...mine, ...others].filter((x) => !n || x.a.includes(n) || (findSession(state, x.a)?.task ?? "").toLowerCase().includes(n));
  }, [state, q]);

  const choose = (x: { a: Address; own: boolean }) => {
    openFeed(x.a, !x.own); // own agents open as chats (switching to the chat view), others as read-only feeds
    close();
  };

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="switcher" role="dialog" aria-label="Switch chat" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Jump to an agent or session"
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(items.length - 1, v + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
            if (e.key === "Enter" && items[i]) choose(items[i]);
            if (e.key === "Escape") close();
          }}
        />
        <ul>
          {items.length === 0 && <li className="empty small">No agent matches "{q}".</li>}
          {items.map((x, j) => {
            const s = findSession(state, x.a);
            return (
              <li key={x.a}>
                <button className={j === i ? "on" : ""} onMouseEnter={() => setI(j)} onClick={() => choose(x)}>
                  {s ? <StatusDot status={s.status} /> : <span className="me-mark">◆</span>}
                  {agentOf(x.a) === HUMAN_AGENT && x.own ? <span>You</span> : <Addr a={x.a} me={state.me} />}
                  <span className="sw-task">{s?.task}</span>
                  <span className="sw-kind">{x.own ? "chat" : "read-only"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
