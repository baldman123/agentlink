import { createContext, useContext, useEffect, useState, type Dispatch } from "react";
import type { Address, SessionStatus } from "../../../contracts/index.ts";
import { agentOf, userColor, userOf, type Transport } from "../lib.ts";
import type { Action, State } from "../store.ts";

export interface AppCtx {
  state: State;
  dispatch: Dispatch<Action>;
  transport: Transport;
  openContext(key: string): void;
  /** Read-only feed in the sidebar. Without `feed`, your own agents open as chats instead. */
  openFeed(address: Address, feed?: boolean): void;
  contextFocus: { key: string; at: number } | null;
  view: "chat" | "team" | "terminals";
  setView(v: "chat" | "team" | "terminals"): void;
  /** Switch to the Terminals view with this agent's pane zoomed. */
  openTerminal(address: Address): void;
  termFocus: { address: Address; at: number } | null;
}
export const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);

/** Re-renders every `ms` so relative times stay fresh. A clock, not a data poll. */
export function useNow(ms = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function StatusDot({ status, title }: { status: SessionStatus | "connected" | "none"; title?: string }) {
  return <span className={`dot dot-${status}`} title={title ?? status} aria-label={title ?? status} role="img" />;
}

export function Avatar({ user, size = 28 }: { user: string; size?: number }) {
  return (
    <span className="avatar" style={{ "--u": userColor(user), width: size, height: size, fontSize: size * 0.42 } as React.CSSProperties}>
      {user.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** "sam/worker-2" with the user part in that user's color. */
export function Addr({ a, me }: { a: Address; me?: string | null }) {
  if (a === "*") return <span className="addr addr-bcast">everyone</span>;
  const u = userOf(a);
  const ag = agentOf(a);
  return (
    <span className="addr">
      <span className="addr-user" style={{ color: userColor(u) }}>{u}</span>
      <span className="addr-sep">/</span>
      <span className="addr-agent">{ag === "*" ? "all agents" : ag}</span>
    </span>
  );
}

export function Resizer({ side, width, setWidth, min, max }: { side: "left" | "right"; width: number; setWidth(w: number): void; min: number; max: number }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setWidth(Math.min(max, Math.max(min, startW + (side === "left" ? dx : -dx))));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10;
    const dir = side === "left" ? 1 : -1;
    if (e.key === "ArrowRight") setWidth(Math.min(max, Math.max(min, width + step * dir)));
    if (e.key === "ArrowLeft") setWidth(Math.min(max, Math.max(min, width - step * dir)));
  };
  return (
    <div
      className={`resizer resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onDown}
      onKeyDown={onKey}
    />
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${88 - ((i * 23) % 40)}%` }} />
      ))}
    </div>
  );
}
