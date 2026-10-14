import { useApp } from "./bits.tsx";

export function ViewToggle() {
  const { view, setView } = useApp();
  return (
    <div className="seg" role="tablist" aria-label="Center view">
      <button role="tab" aria-selected={view === "chat"} className={view === "chat" ? "on" : ""} onClick={() => setView("chat")}>
        Chat
      </button>
      <button role="tab" aria-selected={view === "team"} className={view === "team" ? "on" : ""} onClick={() => setView("team")}>
        Team
      </button>
    </div>
  );
}
