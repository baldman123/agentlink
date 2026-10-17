"use client";
import { useState } from "react";
import { useApp } from "../../ui/src/components/bits.tsx";
import { signOut } from "../lib/client/api.ts";
import { Brand } from "./Brand.tsx";

const CONN_LABEL = { connected: "Live", connecting: "Connecting", reconnecting: "Reconnecting", offline: "Offline" } as const;

export function CloudHeader({
  owner,
  theme,
  toggleTheme,
  calls,
  callsOpen,
  toggleCalls,
}: {
  owner: boolean;
  theme: string;
  toggleTheme(): void;
  calls: number;
  callsOpen: boolean;
  toggleCalls(): void;
}) {
  const { state } = useApp();
  const [leaving, setLeaving] = useState(false);
  const daemonOn = state.me ? state.users[state.me]?.connected : undefined;
  return (
    <header className="topbar">
      <Brand />
      <div className="who">
        {state.me ? (
          <>
            signed in as <strong>{state.me}</strong>
            <span className="who-sub">
              {" · "}
              {daemonOn === undefined ? "" : daemonOn ? "your laptop is connected" : "your laptop isn't connected"}
            </span>
          </>
        ) : (
          "signing in…"
        )}
      </div>
      <span className="grow" />
      <div className={`conn-cloud conn-${state.conn}`} role="status" title={state.connDetail || undefined}>
        <span className="conn-dot" />
        <span className="conn-text">{CONN_LABEL[state.conn]}{state.conn !== "connected" && state.connDetail ? ` · ${state.connDetail}` : ""}</span>
      </div>
      <button
        className={`calls-btn${calls ? " has-calls" : ""}`}
        onClick={toggleCalls}
        aria-pressed={callsOpen}
        aria-label={calls ? `Your calls, ${calls} waiting` : "Your calls"}
        data-testid="calls-btn"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path d="M3 3.5h10v7H8.5L5.5 13v-2.5H3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
          <path d="M8 5.6v2.2M8 9.4v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="calls-btn-text">Calls</span>
        {calls > 0 && <span className="calls-badge">{calls}</span>}
      </button>
      {owner && (
        <a className="navlink" href="/admin">
          People
        </a>
      )}
      <button className="btn btn-ghost icon" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Toggle theme">
        {theme === "dark" ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map((d) => <line key={d} x1="8" y1="1.6" x2="8" y2="3" transform={`rotate(${d} 8 8)`} />)}</g></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z" fill="currentColor" /></svg>
        )}
      </button>
      <button
        className="btn btn-ghost"
        disabled={leaving}
        onClick={() => {
          setLeaving(true);
          void signOut();
        }}
      >
        Sign out
      </button>
    </header>
  );
}
