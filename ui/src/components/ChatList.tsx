import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { agentOf, bodyPreview, involves, relTime } from "../lib.ts";
import { findSession, myChats } from "../store.ts";
import { Skeleton, StatusDot, useApp, useNow } from "./bits.tsx";

export function ChatList() {
  const { state, dispatch, view, setView } = useApp();
  const now = useNow();
  const chats = myChats(state);
  const all = Object.values(state.messages);

  return (
    <nav className="chatlist" aria-label="Your chats">
      <div className="panel-title">
        <span>{state.me ? `${state.me}'s agents` : "Agents"}</span>
        <kbd className="kbd" title="Switch chat">⌘K</kbd>
      </div>
      {!state.snapshotReady && <div className="pad"><Skeleton lines={5} /></div>}
      {state.snapshotReady && chats.length <= 1 && (
        <div className="empty small">
          <strong>No agents yet.</strong>
          <span>They show up here once they register with your daemon.</span>
        </div>
      )}
      <ul>
        {chats.map((a) => {
          const s = findSession(state, a);
          const isMe = agentOf(a) === HUMAN_AGENT;
          const last = all.filter((m) => m.type !== "status" && m.type !== "context_update" && involves(m, a)).reduce<(typeof all)[0] | null>((x, m) => (!x || m.timestamp > x.timestamp ? m : x), null);
          const unread = state.unread[a] ?? 0;
          return (
            <li key={a}>
              <button
                className={`chat ${state.selected === a && view === "chat" ? "active" : ""} ${isMe ? "chat-me" : ""}`}
                onClick={() => {
                  dispatch({ type: "select", address: a });
                  setView("chat");
                }}
                aria-current={state.selected === a}
              >
                <span className="chat-dot">{isMe ? <span className="me-mark" aria-hidden>◆</span> : <StatusDot status={s?.status ?? "offline"} />}</span>
                <span className="chat-main">
                  <span className="chat-name">
                    {isMe ? "You" : agentOf(a)}
                    {s?.kind === "orchestrator" && <span className="kind">orch</span>}
                  </span>
                  <span className="chat-sub">{isMe ? "Your inbox & broadcasts" : s?.task || (last ? bodyPreview(last.body) : s?.status)}</span>
                </span>
                <span className="chat-side">
                  {last && <span className="chat-time">{relTime(last.timestamp, now).replace(" ago", "")}</span>}
                  {unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
