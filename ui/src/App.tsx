import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Address } from "../../contracts/index.ts";
import { DAEMON_PORT, MOCK, safeStorage, saveStorage, userOf } from "./lib.ts";
import { mockTransport } from "./mock/mockTransport.ts";
import { realTransport } from "./realTransport.ts";
import { initialState, reducer } from "./store.ts";
import { Ctx, Resizer, type AppCtx } from "./components/bits.tsx";
import { ChatList } from "./components/ChatList.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ActivityStrip, Header, Switcher, Toasts } from "./components/Chrome.tsx";
import { Sidebar, type Tab } from "./components/Sidebar.tsx";

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

  const [tab, setTab] = useState<Tab>("sessions");
  const [feed, setFeed] = useState<Address | null>(null);
  const [contextFocus, setContextFocus] = useState<AppCtx["contextFocus"]>(null);
  const [switcher, setSwitcher] = useState(false);

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
            onFrame: (frame) => dispatch({ type: "frame", frame }),
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
    if (state.conn === "connected" && !transport.mock)
      transport.bootstrap().then((b) => dispatch({ type: "boot", me: b.user, hubUrl: b.hub_http })).catch(() => {});
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
        return;
      }
      setTab("sessions");
      setFeed(address);
    },
    [state.me],
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

  const ctx: AppCtx = { state, dispatch, transport, openContext, openFeed, contextFocus };

  return (
    <Ctx.Provider value={ctx}>
      <div className="app" style={{ "--left": `${leftW}px`, "--right": `${rightW}px` } as React.CSSProperties}>
        <Header theme={theme} toggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} />
        <ActivityStrip />
        <main className="cols">
          <ChatList />
          <Resizer side="left" width={leftW} setWidth={setLeftW} min={200} max={380} />
          <ChatView />
          <Resizer side="right" width={rightW} setWidth={setRightW} min={280} max={560} />
          <Sidebar tab={tab} setTab={setTab} feed={feed} setFeed={setFeed} />
        </main>
        <Toasts />
        {switcher && <Switcher close={() => setSwitcher(false)} />}
      </div>
    </Ctx.Provider>
  );
}
