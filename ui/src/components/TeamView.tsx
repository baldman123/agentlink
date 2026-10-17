import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Address, Session, UserPresence } from "../../../contracts/index.ts";
import { HUMAN_AGENT } from "../../../contracts/index.ts";
import { userColor, userOf } from "../lib.ts";
import { sortSessions, viaClaude4, type Pulse } from "../store.ts";
import { Avatar, Skeleton, StatusDot, useApp, useNow } from "./bits.tsx";
import { UsageMeter } from "./UsageMeter.tsx";
import { ViewToggle } from "./ViewToggle.tsx";

const PULSE_MS = 1100; // travel time along the line
const RING_MS = 900; // arrival ring on the recipient
const CORNERS = ["worker-1", "worker-2", "worker-3", "worker-4"] as const;

type Point = { x: number; y: number };

/** Where a pulse ends for broadcast targets: "user/*" → that user's orchestrator; "*" → every other orchestrator. */
function targets(p: Pulse, users: UserPresence[]): Address[] {
  if (p.to === "*") return users.filter((u) => u.user !== userOf(p.from)).map((u) => `${u.user}/orchestrator`);
  if (p.to.endsWith("/*")) return [`${userOf(p.to)}/orchestrator`];
  return [p.to];
}

function Node({ s, slot, ring, onOpen }: { s?: Session; slot: string; ring: boolean; onOpen(): void }) {
  const now = useNow();
  if (!s) {
    return (
      <div className={`tnode tnode-empty slot-${slot}`} aria-label={`${slot} not running`}>
        <span className="tnode-name">{slot}</span>
        <span className="tnode-task">not running</span>
      </div>
    );
  }
  const orch = slot === "orchestrator";
  const idleFor = Math.round((now - Date.parse(s.last_activity)) / 1000);
  return (
    <button
      className={`tnode slot-${slot} st-${s.status} ${orch ? "tnode-orch" : ""} ${ring ? "ring" : ""}`}
      data-addr={s.address}
      onClick={onOpen}
      title={`${s.address} · ${s.status}${s.task ? ` · ${s.task}` : ""}`}
    >
      {orch && <span className="orbit" aria-hidden />}
      {!orch && <span className="scan" aria-hidden />}
      <span className="tnode-top">
        <StatusDot status={s.status} />
        <span className="tnode-name">{orch ? "orchestrator" : s.agent}</span>
      </span>
      <span className="tnode-task">{s.task || (s.status === "idle" && idleFor > 60 ? `idle ${Math.round(idleFor / 60)}m` : s.status)}</span>
    </button>
  );
}

function Cluster({ u, me, rings, open }: { u: UserPresence; me: string | null; rings: Set<Address>; open(a: Address): void }) {
  const by = new Map(u.sessions.map((s) => [s.agent, s]));
  const extras = sortSessions(u.sessions.filter((s) => s.agent !== HUMAN_AGENT && s.agent !== "orchestrator" && !CORNERS.includes(s.agent as never)));
  const human = `${u.user}/${HUMAN_AGENT}`;
  return (
    <section className={`cluster ${u.connected ? "" : "cluster-off"}`} style={{ "--u": userColor(u.user) } as React.CSSProperties}>
      <header className="cluster-head">
        <Avatar user={u.user} size={22} />
        <span className="cluster-user">{u.user}{u.user === me && <span className="you"> (you)</span>}</span>
        <span className={`presence ${u.connected ? "on" : "off"}`}>{u.connected ? "online" : "offline"}</span>
        {viaClaude4(u) && <span className="via">via claude4</span>}
        <span className="grow" />
        <button className={`tnode tnode-human ${rings.has(human) ? "ring" : ""}`} data-addr={human} onClick={() => open(human)} title={`${human}: the person at the keyboard`}>
          <span className="me-mark" aria-hidden>◆</span> human
        </button>
      </header>
      <UsageMeter user={u.user} />
      <div className="cl-grid">
        {(["worker-1", "worker-2"] as const).map((w) => (
          <Node key={w} slot={w} s={by.get(w)} ring={rings.has(`${u.user}/${w}`)} onOpen={() => open(`${u.user}/${w}`)} />
        ))}
        <Node slot="orchestrator" s={by.get("orchestrator")} ring={rings.has(`${u.user}/orchestrator`)} onOpen={() => open(`${u.user}/orchestrator`)} />
        {(["worker-3", "worker-4"] as const).map((w) => (
          <Node key={w} slot={w} s={by.get(w)} ring={rings.has(`${u.user}/${w}`)} onOpen={() => open(`${u.user}/${w}`)} />
        ))}
      </div>
      {extras.length > 0 && (
        <div className="cl-extras">
          also:{" "}
          {extras.map((s) => (
            <button key={s.address} className="extra" data-addr={s.address} onClick={() => open(s.address)}>
              <StatusDot status={s.status} /> {s.agent}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function TeamView() {
  const { state, dispatch, openFeed, setView } = useApp();
  const canvas = useRef<HTMLDivElement>(null);
  const [pts, setPts] = useState<Record<Address, Point>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [, force] = useState(0);

  const users = useMemo(
    () => Object.values(state.users).sort((a, b) => (a.user === state.me ? -1 : b.user === state.me ? 1 : a.user.localeCompare(b.user))),
    [state.users, state.me],
  );

  // node centers, measured from the DOM; re-measured on resize and whenever the roster changes
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<Address, Point> = {};
      el.querySelectorAll<HTMLElement>("[data-addr]").forEach((n) => {
        const r = n.getBoundingClientRect();
        next[n.dataset.addr!] = { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
      });
      setPts(next);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [users]);

  // re-render once the newest pulse has finished, so expired pulses drop out (a timer, not a data poll)
  const newest = state.pulses.reduce((m, p) => Math.max(m, p.deliveredAt ?? p.at), 0);
  useEffect(() => {
    if (!newest) return;
    const t = setTimeout(() => force((n) => n + 1), Math.max(0, newest + PULSE_MS + RING_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [newest]);

  const now = Date.now();
  const live = state.pulses.filter((p) => now - p.at < PULSE_MS + 200);
  const rings = new Set<Address>();
  for (const p of state.pulses) {
    const arrived = p.deliveredAt ?? p.at + PULSE_MS;
    if (now - arrived < RING_MS && now >= p.at) for (const t of targets(p, users)) rings.add(t);
  }

  const open = (a: Address) => {
    if (userOf(a) === state.me) {
      dispatch({ type: "select", address: a });
      setView("chat");
    } else openFeed(a, true);
  };

  if (!state.snapshotReady) {
    return (
      <section className="center">
        <div className="center-head"><Skeleton lines={1} /><span className="grow" /><ViewToggle /></div>
        <div className="pad"><Skeleton lines={8} /></div>
      </section>
    );
  }

  const agentCount = users.reduce((n, u) => n + u.sessions.filter((s) => s.agent !== HUMAN_AGENT).length, 0);
  const working = users.reduce((n, u) => n + u.sessions.filter((s) => s.status === "working").length, 0);

  return (
    <section className="center">
      <div className="center-head">
        <div className="ch-title">
          <div className="ch-name">Teams</div>
          <div className="ch-task">
            {users.length} {users.length === 1 ? "laptop" : "laptops"} · {agentCount} agents · {working} working
          </div>
        </div>
        <span className="grow" />
        <ViewToggle />
      </div>
      <div className="team-scroll">
        {users.length === 0 ? (
          <div className="empty">
            <strong>No teams on the hub yet.</strong>
            <span>Start a daemon and its bridge on each laptop; their agents appear here.</span>
          </div>
        ) : (
          <div className="team-canvas" ref={canvas}>
            <svg className="wires" width={size.w} height={size.h} aria-hidden>
              {users.map((u) => {
                const o = pts[`${u.user}/orchestrator`];
                if (!o) return null;
                return u.sessions
                  .filter((s) => s.agent !== "orchestrator")
                  .concat([{ address: `${u.user}/${HUMAN_AGENT}` } as Session])
                  .map((s) => pts[s.address] && <line key={s.address} className="wire-base" x1={o.x} y1={o.y} x2={pts[s.address].x} y2={pts[s.address].y} />);
              })}
              {live.flatMap((p) =>
                targets(p, users).map((t) => {
                  const a = pts[p.from];
                  const b = pts[t];
                  if (!a || !b || p.from === t) return null;
                  const cross = userOf(p.from) !== userOf(t);
                  return (
                    <g key={`${p.id}>${t}`} className={`pulse ${cross ? "pulse-cross" : ""}`}>
                      <line className="pulse-track" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                      <line className="pulse-head" x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={1} />
                    </g>
                  );
                }),
              )}
            </svg>
            {users.map((u) => (
              <Cluster key={u.user} u={u} me={state.me} rings={rings} open={open} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
