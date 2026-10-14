import { useApp, type AppCtx } from "./bits.tsx";

const VIEWS: Array<[AppCtx["view"], string]> = [
  ["chat", "Chat"],
  ["team", "Team"],
  ["terminals", "Terminals"],
];

export function ViewToggle() {
  const { view, setView } = useApp();
  return (
    <div className="seg" role="tablist" aria-label="Center view">
      {VIEWS.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
