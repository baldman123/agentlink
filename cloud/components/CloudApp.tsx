"use client";
// The signed-in app: ui/src's App wired to the cloud transport, with the website's header (sign out,
// admin) and a phone layout that shows one column at a time with tabs at the bottom.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Address } from "../../contracts/index.ts";
import { safeStorage, saveStorage, userOf } from "../../ui/src/lib.ts";
import { initialState, reducer } from "../../ui/src/store.ts";
import { Ctx, Resizer, type AppCtx } from "../../ui/src/components/bits.tsx";
import { ChatList } from "../../ui/src/components/ChatList.tsx";
import { ChatView } from "../../ui/src/components/ChatView.tsx";
import { ActivityStrip, Switcher, Toasts } from "../../ui/src/components/Chrome.tsx";
import { Sidebar, type Tab } from "../../ui/src/components/Sidebar.tsx";
import { TeamView } from "../../ui/src/components/TeamView.tsx";
import { TerminalsView } from "../../ui/src/components/TerminalsView.tsx";
import { screenStore } from "../../ui/src/screens.ts";
import { cloudTransport } from "../lib/client/cloudTransport.ts";
import { CallsPanel, useCalls } from "./CallsPanel.tsx";
import { CloudHeader } from "./CloudHeader.tsx";

type MobilePane = "list" | "center" | "side";
const PHONE = "(max-width: 820px)";

export function CloudApp() {
  const transport = useMemo(() => cloudTransport(), []);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [owner, setOwner] = useState(false);
  const seqRef = useRef<number | undefined>(undefined);
  seqRef.current = state.lastSeq;

  const [theme, setTheme] = useState<string>(() => safeStorage("al.theme", "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveStorage("al.theme", theme);
  }, [theme]);

  const [leftW, setLeftW] = useState(() => safeStorage("al.leftW", 260));
  const [rightW, setRightW] = useState(() => safeStorage("al.rightW", 360));
  useEffect(() => saveStorage("al.leftW", leftW), [leftW]);
  useEffect(() => saveStorage("al.rightW", rightW), [rightW]);

  const [tab, setTab] = useState<Tab>("boss"); // the boss panel is what you see first
  // phone: the boss panel first, unless the link asks for a view (?view=terminals), which then opens directly
  const [mobile, setMobile] = useState<MobilePane>(() => {
    const q = new URLSearchParams(location.search).get("view");
    return q && q !== "calls" ? "center" : "side"; // ?view=calls opens the calls popup over the usual first pane
  });
  const [feed, setFeed] = useState<Address | null>(null);
  const [contextFocus, setContextFocus] = useState<AppCtx["contextFocus"]>(null);
  const [switcher, setSwitcher] = useState(false);
  const [termFocus, setTermFocus] = useState<AppCtx["termFocus"]>(null);
  const [view, setViewState] = useState<AppCtx["view"]>(() => {
    const ok = (v: unknown): v is AppCtx["view"] => v === "chat" || v === "team" || v === "terminals";
    const q = new URLSearchParams(location.search).get("view");
    if (ok(q)) return q;
    const saved = safeStorage<unknown>("al.view", "chat");
    return ok(saved) ? saved : "chat";
  });
  useEffect(() => saveStorage("al.view", view), [view]);
  // "Your calls" is a popup under the header button; it floats over whatever view is showing
  const calls = useCalls();
  const [callsOpen, setCallsOpen] = useState(() => new URLSearchParams(location.search).get("view") === "calls");
  const setView = useCallback((v: AppCtx["view"]) => {
    setViewState(v);
    setMobile("center");
  }, []);

  // sign-in check, then the live connection; the transport turns Realtime into hub frames
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    transport
      .bootstrap()
      .then((b) => {
        if (cancelled) return;
        dispatch({ type: "boot", me: b.user, hubUrl: b.hub_http });
        setOwner(!!transport.me()?.owner);
        stop = transport.connect(
          {
            onFrame: (frame) => {
              if (frame.op === "screen") screenStore.put(frame.address, frame.screen, frame.at);
              else if (frame.op === "screen.gone") screenStore.gone(frame.address);
              else dispatch({ type: "frame", frame });
            },
            onState: (s, detail) => dispatch({ type: "conn", state: s, detail }),
          },
          () => seqRef.current,
        );
      })
      .catch(() => dispatch({ type: "conn", state: "offline", detail: "can't reach agentlink" }));
    return () => {
      cancelled = true;
      stop();
    };
  }, [transport]);

  useEffect(() => {
    document.title = `${calls.pending ? `(${calls.pending}) ` : ""}${state.me ? `${state.me} · agentlink` : "agentlink"}`;
  }, [state.me, calls.pending]);

  // phone: picking a chat in the list opens it
  const firstSelect = useRef(true);
  useEffect(() => {
    if (!state.selected) return;
    if (firstSelect.current) return void (firstSelect.current = false);
    if (window.matchMedia(PHONE).matches) setMobile("center");
  }, [state.selected]);

  const openContext = useCallback((key: string) => {
    setTab("context");
    setContextFocus({ key, at: Date.now() });
    setMobile("side");
  }, []);
  const openFeed = useCallback(
    (address: Address, asFeed?: boolean) => {
      if (!asFeed && state.me && userOf(address) === state.me && address !== `${state.me}/*`) {
        dispatch({ type: "select", address });
        setView("chat");
        return;
      }
      setTab("sessions");
      setFeed(address);
      setMobile("side");
    },
    [state.me, setView],
  );
  const openTerminal = useCallback(
    (address: Address) => {
      setTermFocus({ address, at: Date.now() });
      setView("terminals");
    },
    [setView],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: AppCtx = { state, dispatch, transport, openContext, openFeed, contextFocus, view, setView, openTerminal, termFocus };
  const unread = Object.values(state.unread).reduce((n, x) => n + x, 0);

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app view-${view} m-${mobile}`} style={{ "--left": `${leftW}px`, "--right": `${rightW}px` } as React.CSSProperties}>
        <CloudHeader
          owner={owner}
          theme={theme}
          toggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          calls={calls.pending}
          callsOpen={callsOpen}
          toggleCalls={() => setCallsOpen((o) => !o)}
          callsPopup={callsOpen && <CallsPanel calls={calls} close={() => setCallsOpen(false)} />}
        />
        <ActivityStrip />
        <main className="cols">
          <ChatList />
          <Resizer side="left" width={leftW} setWidth={setLeftW} min={200} max={380} />
          {view === "team" ? (
            <TeamView />
          ) : view === "terminals" ? (
            <TerminalsView />
          ) : (
            <ChatView />
          )}
          <Resizer side="right" width={rightW} setWidth={setRightW} min={280} max={560} />
          <Sidebar tab={tab} setTab={setTab} feed={feed} setFeed={setFeed} />
        </main>
        <nav className="mtabs" role="tablist" aria-label="Sections">
          <button role="tab" aria-selected={mobile === "list"} onClick={() => setMobile("list")}>
            <svg viewBox="0 0 18 18" aria-hidden><path d="M3 4.5h12M3 9h12M3 13.5h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
            Chats{unread ? ` (${unread})` : ""}
          </button>
          <button role="tab" aria-selected={mobile === "center"} onClick={() => setMobile("center")}>
            <svg viewBox="0 0 18 18" aria-hidden><rect x="2.5" y="3" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="M2.5 7h13" stroke="currentColor" strokeWidth="1.6" /></svg>
            {view === "team" ? "Team" : view === "terminals" ? "Terminals" : "Chat"}
          </button>
          <button
            aria-haspopup="dialog"
            aria-expanded={callsOpen}
            aria-label={calls.pending ? `Calls, ${calls.pending} waiting` : "Calls"}
            onClick={() => setCallsOpen((o) => !o)}
            data-calls-toggle
          >
            <svg viewBox="0 0 18 18" aria-hidden><path d="M3 3.5h12v8H9.5L6 14.5v-3H3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" /><path d="M9 6v2.6M9 10.4v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            Calls
            {calls.pending > 0 && <span className="calls-badge mtab-badge">{calls.pending}</span>}
          </button>
          <button role="tab" aria-selected={mobile === "side"} onClick={() => setMobile("side")}>
            <svg viewBox="0 0 18 18" aria-hidden><path d="M9 2.5 15.5 9 9 15.5 2.5 9z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" /></svg>
            Boss
          </button>
        </nav>
        <Toasts />
        {switcher && <Switcher close={() => setSwitcher(false)} />}
      </div>
    </Ctx.Provider>
  );
}
