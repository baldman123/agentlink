import type { Address } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { relTime, userOf } from "../lib.ts";
import { findSession } from "../store.ts";
import { Addr, Avatar, Skeleton, StatusDot, useApp, useNow } from "./bits.tsx";
import { MessageList } from "./ChatView.tsx";
import { ContextPanel } from "./ContextPanel.tsx";

export type Tab = "sessions" | "context";

function Sessions() {
  const { state, openFeed } = useApp();
  const now = useNow();
  const users = Object.values(state.users).sort((a, b) => (a.user === state.me ? -1 : b.user === state.me ? 1 : a.user.localeCompare(b.user)));

  if (!state.snapshotReady) return <div className="pad"><Skeleton lines={6} /></div>;
  if (!users.length)
    return (
      <div className="empty">
        <strong>Nobody is on the hub yet.</strong>
        <span>Start a daemon on any laptop and its sessions appear here.</span>
      </div>
    );
  return (
    <div className="sessions">
      {users.map((u) => {
        const sessions = u.sessions.filter((s) => s.agent !== HUMAN_AGENT);
        return (
          <section key={u.user} className="ugroup">
            <header className="ugroup-head">
              <Avatar user={u.user} size={22} />
              <span className="ugroup-name">{u.user}{u.user === state.me && <span className="you"> (you)</span>}</span>
              <span className={`presence ${u.connected ? "on" : "off"}`}>{u.connected ? "online" : "offline"}</span>
              {u.hub_address && <span className="ip">{u.hub_address}</span>}
            </header>
            {sessions.length === 0 && <div className="empty small inline">No agents running.</div>}
            <ul>
              {sessions.map((s) => (
                <li key={s.address}>
                  <button className="sess" onClick={() => openFeed(s.address, true)}>
                    <StatusDot status={s.status} />
                    <span className="sess-main">
                      <span className="sess-name">
                        {s.agent}
                        {s.kind !== "worker" && <span className="kind">{s.kind === "orchestrator" ? "orch" : s.kind}</span>}
                      </span>
                      <span className="sess-task">{s.task || <em>{s.status}</em>}</span>
                    </span>
                    <time className="sess-time" dateTime={s.last_activity}>{relTime(s.last_activity, now)}</time>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Feed({ address, close }: { address: Address; close(): void }) {
  const { state, dispatch } = useApp();
  const s = findSession(state, address);
  const mine = userOf(address) === state.me;
  return (
    <div className="feed">
      <header className="feed-head">
        <button className="btn btn-ghost" onClick={close} aria-label="Back to sessions">←</button>
        <div className="feed-title">
          <Addr a={address} me={state.me} />
          <span className="feed-sub">
            {s && <StatusDot status={s.status} />} {s?.status ?? "unknown"} · read-only
          </span>
        </div>
        {mine && (
          <button className="btn btn-ghost" onClick={() => dispatch({ type: "select", address })}>
            Open chat
          </button>
        )}
      </header>
      <MessageList address={address} compact />
    </div>
  );
}

export function Sidebar({ tab, setTab, feed, setFeed }: { tab: Tab; setTab(t: Tab): void; feed: Address | null; setFeed(a: Address | null): void }) {
  const { state } = useApp();
  const sessionCount = Object.values(state.users).reduce((n, u) => n + u.sessions.filter((s) => s.agent !== HUMAN_AGENT && s.status !== "offline").length, 0);
  const ctxCount = Object.keys(state.context).length;
  return (
    <aside className="sidebar">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "sessions"} className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>
          Sessions <span className="count">{sessionCount}</span>
        </button>
        <button role="tab" aria-selected={tab === "context"} className={tab === "context" ? "on" : ""} onClick={() => setTab("context")}>
          Shared context <span className="count">{ctxCount}</span>
        </button>
      </div>
      <div className="tabpanel" role="tabpanel">
        {tab === "sessions" ? feed ? <Feed address={feed} close={() => setFeed(null)} /> : <Sessions /> : <ContextPanel />}
      </div>
    </aside>
  );
}
