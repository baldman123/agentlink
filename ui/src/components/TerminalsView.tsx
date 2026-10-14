import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Address, Session, UserPresence } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { cssOf, parseAnsi } from "../ansi.ts";
import { safeStorage, saveStorage, userColor, userOf } from "../lib.ts";
import { screenStore, useScreen, useScreensVersion } from "../screens.ts";
import type { Pulse } from "../store.ts";
import { Skeleton, useApp } from "./bits.tsx";
import { ViewToggle } from "./ViewToggle.tsx";

const SLOTS = [
  { agent: "worker-1", label: "WORKER 1", pos: "tl" },
  { agent: "worker-2", label: "WORKER 2", pos: "tr" },
  { agent: "worker-3", label: "WORKER 3", pos: "bl" },
  { agent: "worker-4", label: "WORKER 4", pos: "br" },
] as const;
const PULSE_MS = 1300;
const RING_MS = 900;
const CHAR_EM = 0.602; // JetBrains Mono advance width

type Point = { x: number; y: number };
type Chip = "working" | "done" | "waiting" | "error" | "offline";

function chipOf(s: Session | undefined, busy: boolean | undefined): Chip {
  if (!s || s.status === "offline") return "offline";
  if (busy || s.status === "working") return "working";
  if (s.status === "waiting") return "waiting";
  if (s.status === "error") return "error";
  return "done";
}

// ---------------------------------------------------------------------------
// screen body: ANSI → spans, fit-to-width font, sticky auto-scroll

const ScreenText = memo(function ScreenText({ text }: { text: string }) {
  const lines = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {lines.map((l, i) => (
        <div className="tl" key={i}>
          {l.length === 0 ? " " : l.map((s, j) => <span key={j} style={cssOf(s.style)}>{s.text}</span>)}
        </div>
      ))}
    </>
  );
});

function ScreenBody({ address, session, zoomed }: { address: Address; session?: Session; zoomed?: boolean }) {
  const st = useScreen(address);
  useScreensVersion(); // re-evaluate availability when the grace period ends
  const avail = screenStore.availability(address);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [font, setFont] = useState(11);
  const cols = st?.screen.cols || 100;

  // fit the terminal's columns to the pane width (clamped so text stays readable)
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth - 20;
      const px = w / (cols * CHAR_EM);
      setFont(Math.max(zoomed ? 10 : 8.5, Math.min(zoomed ? 15 : 12, Math.floor(px * 4) / 4)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cols, zoomed]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [st?.screen.text, font]);

  if (!st) {
    return (
      <div className="tbody tbody-empty">
        {avail === "waiting" ? (
          <Skeleton lines={3} />
        ) : (
          <div className="noscreen">
            <strong>screen not shared</strong>
            <span>{session?.task || (session ? session.status : "not running")}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="tbody"
      ref={box}
      style={{ fontSize: font }}
      onScroll={() => {
        const el = box.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <ScreenText text={st.screen.text} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// one pane (worker quadrant, or the boss / any agent when zoomed)

function Pane({
  address, label, pos, session, active, ring, onZoom, zoomed, onClose,
}: {
  address: Address; label: string; pos: string; session?: Session; active: boolean; ring: boolean;
  onZoom?(): void; zoomed?: boolean; onClose?(): void;
}) {
  const st = useScreen(address);
  const chip = chipOf(session, st?.screen.busy);
  const user = userOf(address);
  if (!session && !zoomed) {
    return (
      <div className={`tpane tpane-${pos} tpane-missing`}>
        <header className="thead"><span className="tlabel">{label}</span><span className="tuser">{user}</span><span className="ttask">not running</span></header>
      </div>
    );
  }
  return (
    <section
      className={`tpane tpane-${pos} ${active ? "active" : ""} ${ring ? "ring" : ""} ${zoomed ? "zoomed" : ""} chip-${chip}`}
      onClick={zoomed ? undefined : onZoom}
      role={zoomed ? "dialog" : "button"}
      tabIndex={zoomed ? -1 : 0}
      aria-label={zoomed ? `${address} terminal` : `Zoom ${address} terminal`}
      onKeyDown={(e) => !zoomed && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onZoom?.())}
    >
      <header className="thead">
        <span className="tlabel">{label}</span>
        <span className="tuser" style={{ color: userColor(user) }}>{user}</span>
        <span className="ttask">{session?.task || "—"}</span>
        <span className={`tchip tchip-${chip}`}>{chip}</span>
        {zoomed ? (
          <button className="tclose" onClick={onClose} aria-label="Close (Esc)">Esc ✕</button>
        ) : (
          <span className="tanchor" data-anchor={address} aria-hidden />
        )}
      </header>
      <ScreenBody address={address} session={session} zoomed={zoomed} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// one user's block: four quadrants + the boss circle

function Block({ u, me, activeAddr, rings, zoom }: { u: UserPresence; me: string | null; activeAddr: Address | null; rings: Set<Address>; zoom(a: Address): void }) {
  const by = new Map(u.sessions.map((s) => [s.agent, s]));
  const boss = by.get("orchestrator");
  const bossAddr = `${u.user}/orchestrator`;
  const shares = screenStore.userSharing(u.user) !== "no";
  const st = useScreen(bossAddr);
  const chip = chipOf(boss, st?.screen.busy);
  return (
    <section className={`tblock ${u.connected ? "" : "tblock-off"}`} style={{ "--u": userColor(u.user) } as React.CSSProperties}>
      <div className="tgrid">
        {SLOTS.map((sl) => {
          const a = `${u.user}/${sl.agent}`;
          return (
            <Pane key={sl.agent} address={a} label={sl.label} pos={sl.pos} session={by.get(sl.agent)} active={activeAddr === a} ring={rings.has(a)} onZoom={() => zoom(a)} />
          );
        })}
      </div>
      <button
        className={`boss chip-${chip} ${rings.has(bossAddr) ? "ring" : ""} ${activeAddr === bossAddr ? "active" : ""}`}
        data-anchor={bossAddr}
        onClick={() => boss && zoom(bossAddr)}
        disabled={!boss}
        title={boss ? `Open ${u.user}'s boss screen` : `${u.user} has no orchestrator`}
      >
        <span className="boss-glow" aria-hidden />
        <span className="boss-mark" aria-hidden>◆</span>
        <span className="boss-name">BOSS</span>
        <span className="boss-user" style={{ color: userColor(u.user) }}>{u.user}{u.user === me ? " · you" : ""}</span>
        <span className="boss-status">{boss ? `${chip}${boss.task ? ` · ${boss.task}` : ""}` : "no orchestrator"}</span>
        <span className="boss-hint">{boss ? (shares ? "click for screen" : "screen not shared") : ""}</span>
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

/** Where a message lands for broadcast targets; human/user/* land on that user's boss. */
function endpoint(a: Address): Address {
  if (a.endsWith("/*") || a.endsWith(`/${HUMAN_AGENT}`)) return `${userOf(a)}/orchestrator`;
  return a;
}

function pulsePath(p: Pulse, to: Address, pts: Record<string, Point>): string | null {
  const A = endpoint(p.from);
  const B = endpoint(to);
  const ua = userOf(A);
  const ub = userOf(B);
  const bossA = pts[`${ua}/orchestrator`];
  const bossB = pts[`${ub}/orchestrator`];
  const a = pts[A];
  const b = pts[B];
  if (!a || !bossA) return null;
  const P: Point[] = [a];
  const isBossA = A === `${ua}/orchestrator`;
  const isBossB = B === `${ub}/orchestrator`;
  if (!isBossA) P.push({ x: bossA.x, y: a.y });
  if (ua === ub) {
    if (!b) return null;
    if (isBossB) P.push(bossA);
    else {
      if (isBossA) P.push(bossA);
      P.push({ x: bossA.x, y: b.y }, b);
    }
  } else {
    P.push(bossA);
    if (!bossB) return null; // other team not on screen: stop at our boss
    P.push(bossB);
    if (!isBossB && b) P.push({ x: bossB.x, y: b.y }, b);
  }
  const dedup = P.filter((q, i) => i === 0 || q.x !== P[i - 1].x || q.y !== P[i - 1].y);
  if (dedup.length < 2) return null;
  return dedup.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
}

export function TerminalsView() {
  const { state, transport } = useApp();
  useScreensVersion(); // sharing labels follow screen arrivals
  const users = useMemo(
    () => Object.values(state.users).sort((a, b) => (a.user === state.me ? -1 : b.user === state.me ? 1 : a.user.localeCompare(b.user))),
    [state.users, state.me],
  );
  const [pick, setPick] = useState<string>(() => safeStorage("al.termUser", ""));
  useEffect(() => saveStorage("al.termUser", pick), [pick]);
  const both = pick === "*";
  const shown = both ? users : users.filter((u) => u.user === (users.some((x) => x.user === pick) ? pick : state.me ?? users[0]?.user));
  const shownKey = shown.map((u) => u.user).join(",");
  const [zoomed, setZoomed] = useState<Address | null>(null);

  // subscribe only to what is on screen: the quadrant panes of the shown users, plus the zoomed pane
  const visible = useMemo(() => {
    const set = new Set<Address>();
    for (const u of shown) for (const s of u.sessions) if (SLOTS.some((sl) => sl.agent === s.agent)) set.add(s.address);
    for (const u of shown) set.add(`${u.user}/orchestrator`); // the boss circle shows busy from its screen
    if (zoomed) set.add(zoomed);
    return [...set].sort();
  }, [shownKey, zoomed, state.users]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (state.conn === "connected") transport.subscribeScreens(visible);
  }, [visible.join(), state.conn, transport]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => transport.subscribeScreens([]), [transport]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  // geometry for connectors + pulses
  const stage = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<Record<string, Point>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<string, Point> = {};
      el.querySelectorAll<HTMLElement>("[data-anchor]").forEach((n) => {
        const r = n.getBoundingClientRect();
        next[n.dataset.anchor!] = { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
      });
      setPts(next);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shownKey, state.users]);

  const [, force] = useState(0);
  const newest = state.pulses.reduce((m, p) => Math.max(m, p.deliveredAt ?? p.at), 0);
  useEffect(() => {
    if (!newest) return;
    const t = setTimeout(() => force((n) => n + 1), Math.max(0, newest + PULSE_MS + RING_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [newest]);
  const now = Date.now();
  const rings = new Set<Address>();
  for (const p of state.pulses) {
    const arrived = p.deliveredAt ?? p.at + PULSE_MS;
    if (now - arrived < RING_MS) {
      const t = p.to === "*" ? null : endpoint(p.to);
      if (t) rings.add(t);
    }
  }
  const livePulses = state.pulses.filter((p) => now - p.at < PULSE_MS + 150);

  const zoomSession = zoomed ? state.users[userOf(zoomed)]?.sessions.find((s) => s.address === zoomed) : undefined;
  const zoomLabel = zoomed ? (zoomed.endsWith("/orchestrator") ? "BOSS" : (SLOTS.find((s) => zoomed.endsWith(`/${s.agent}`))?.label ?? zoomed.split("/")[1].toUpperCase())) : "";

  return (
    <section className="center terms">
      <div className="center-head">
        <div className="ch-title">
          <div className="ch-name">Terminals</div>
          <div className="ch-task">Read-only live screens. Click a pane to zoom, the circle for the boss.</div>
        </div>
        <span className="grow" />
        {users.length > 0 && (
          <div className="seg" role="tablist" aria-label="Whose terminals">
            {users.map((u) => (
              <button key={u.user} role="tab" aria-selected={!both && shown[0]?.user === u.user} className={!both && shown[0]?.user === u.user ? "on" : ""} onClick={() => setPick(u.user)}>
                <span className="seg-dot" style={{ background: userColor(u.user) }} />
                {u.user}
                {screenStore.userSharing(u.user) === "no" && <span className="seg-note">not sharing</span>}
              </button>
            ))}
            {users.length > 1 && (
              <button role="tab" aria-selected={both} className={both ? "on" : ""} onClick={() => setPick("*")}>both</button>
            )}
          </div>
        )}
        <ViewToggle />
      </div>
      {!state.snapshotReady ? (
        <div className="pad"><Skeleton lines={10} /></div>
      ) : users.length === 0 ? (
        <div className="empty big"><strong>No teams on the hub yet.</strong><span>Start a daemon and bridge on each laptop to see their terminals.</span></div>
      ) : (
        <div className={`tstage-scroll ${both ? "both" : ""}`}>
          <div className="tstage" ref={stage}>
            <svg className="twires" width={size.w} height={size.h} aria-hidden>
              {shown.map((u) => {
                const c = pts[`${u.user}/orchestrator`];
                if (!c) return null;
                return SLOTS.map((sl) => {
                  const a = pts[`${u.user}/${sl.agent}`];
                  return a && <path key={`${u.user}${sl.agent}`} className="twire" d={`M${a.x} ${a.y} H${c.x} V${c.y}`} />;
                });
              })}
              {both && shown.length > 1 && shown.slice(1).map((u, i) => {
                const a = pts[`${shown[i].user}/orchestrator`];
                const b = pts[`${u.user}/orchestrator`];
                return a && b && <path key={`x${u.user}`} className="twire twire-cross" d={`M${a.x} ${a.y} L${b.x} ${b.y}`} />;
              })}
              {livePulses.flatMap((p) => {
                const tos = p.to === "*" ? users.filter((u) => u.user !== userOf(p.from)).map((u) => `${u.user}/orchestrator`) : [p.to];
                return tos.map((t) => {
                  const d = pulsePath(p, t, pts);
                  return d && (
                    <g key={`${p.id}>${t}`} className={`pulse ${userOf(p.from) !== userOf(t) ? "pulse-cross" : ""}`}>
                      <path className="pulse-track" d={d} />
                      <path className="pulse-head tpulse" d={d} pathLength={1} />
                    </g>
                  );
                });
              })}
            </svg>
            {shown.map((u) => (
              <Block key={u.user} u={u} me={state.me} activeAddr={zoomed ?? state.selected} rings={rings} zoom={setZoomed} />
            ))}
          </div>
          {zoomed && (
            <div className="tzoom" onMouseDown={(e) => e.target === e.currentTarget && setZoomed(null)}>
              <Pane address={zoomed} label={zoomLabel} pos="zoom" session={zoomSession} active ring={false} zoomed onClose={() => setZoomed(null)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
