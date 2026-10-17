import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Address } from "../../contracts/index.ts";
import { DAEMON_PORT, MOCK, params, safeStorage, saveStorage, userOf } from "./lib.ts";
import { mockTransport } from "./mock/mockTransport.ts";
import { realTransport } from "./realTransport.ts";
import { initialState, reducer } from "./store.ts";
import { Ctx, Resizer, type AppCtx } from "./components/bits.tsx";
import { ChatList } from "./components/ChatList.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ActivityStrip, Header, Switcher, Toasts } from "./components/Chrome.tsx";
import { Sidebar, type Tab } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { TerminalsView } from "./components/TerminalsView.tsx";
import { screenStore } from "./screens.ts";

export function App() {
  const transport = useMemo(() => (MOCK ? mockTransport(DAEMON_PORT) : realTransport(DAEMON_PORT)), []);
  const [state, dispatch] = useReducer(reducer, initialState);
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
  const [feed, setFeed] = useState<Address | null>(null);
  const [contextFocus, setContextFocus] = useState<AppCtx["contextFocus"]>(null);
  const [switcher, setSwitcher] = useState(false);
  const [termFocus, setTermFocus] = useState<AppCtx["termFocus"]>(null);
  const [view, setView] = useState<AppCtx["view"]>(() => {
    const ok = (v: unknown): v is AppCtx["view"] => v === "chat" || v === "team" || v === "terminals";
    const q = params.get("view");
    if (ok(q)) return q;
    const saved = safeStorage<unknown>("al.view", "chat");
    return ok(saved) ? saved : "chat";
  });
  useEffect(() => saveStorage("al.view", view), [view]);

  // connect: bootstrap → hub WS. Live updates come only from WS events.
  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    transport
      .bootstrap()
      .then((b) => dispatch({ type: "boot", me: b.user, hubUrl: b.hub_http }))
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        stop = transport.connect(
          {
            onFrame: (frame) => {
              // live screens bypass the reducer (see screens.ts)
              if (frame.op === "screen") screenStore.put(frame.address, frame.screen, frame.at);
              else if (frame.op === "screen.gone") screenStore.gone(frame.address);
              else dispatch({ type: "frame", frame });
            },
            onState: (s, detail) => dispatch({ type: "conn", state: s, detail }),
          },
          () => seqRef.current,
        );
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [transport]);

  // the daemon may only learn its user/hub after a retry; refresh boot info on connect
  useEffect(() => {
    if (state.conn === "connected") // the hub may be at a new address after a search
      transport.bootstrap().then((b) => dispatch({ type: "boot", me: b.user, hubUrl: b.hub_http })).catch(() => {});
  }, [state.conn, transport]);

  // the daemon's hub link (how it was found, pinned hub_id, searching): read once per connect, and
  // every 3s only while the hub socket is down (the one allowed poll; everything else is events)
  useEffect(() => {
    let alive = true;
    const read = () => transport.health().then((h) => alive && dispatch({ type: "health", hub: h?.hub ?? null }));
    read();
    if (state.conn === "connected") return () => { alive = false; };
    const t = setInterval(read, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [state.conn, transport]);

  useEffect(() => {
    document.title = state.me ? `${state.me} · agentlink` : "agentlink";
  }, [state.me]);

  const openContext = useCallback((key: string) => {
    setTab("context");
    setContextFocus({ key, at: Date.now() });
  }, []);
  const openFeed = useCallback(
    (address: Address, feed?: boolean) => {
      if (!feed && state.me && userOf(address) === state.me && address !== `${state.me}/*`) {
        dispatch({ type: "select", address });
        setView("chat");
        return;
      }
      setTab("sessions");
      setFeed(address);
    },
    [state.me],
  );

  const openTerminal = useCallback((address: Address) => {
    setTermFocus({ address, at: Date.now() });
    setView("terminals");
  }, []);

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

  return (
    <Ctx.Provider value={ctx}>
      <div className={`app view-${view}`} style={{ "--left": `${leftW}px`, "--right": `${rightW}px` } as React.CSSProperties}>
        <Header theme={theme} toggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
        <ActivityStrip />
        <main className="cols">
          <ChatList />
          <Resizer side="left" width={leftW} setWidth={setLeftW} min={200} max={380} />
          {view === "team" ? <TeamView /> : view === "terminals" ? <TerminalsView /> : <ChatView />}
          <Resizer side="right" width={rightW} setWidth={setRightW} min={280} max={560} />
          <Sidebar tab={tab} setTab={setTab} feed={feed} setFeed={setFeed} />
        </main>
        <Toasts />
        {switcher && <Switcher close={() => setSwitcher(false)} />}
      </div>
    </Ctx.Provider>
  );
}
