/** The agentlink mark: two lamps on a wire (same as the local app). */
export function Brand({ big = false }: { big?: boolean }) {
  return (
    <div className={big ? "brand gate-brand" : "brand"}>
      <svg width={big ? 30 : 22} height={big ? 19 : 14} viewBox="0 0 22 14" aria-hidden>
        <circle cx="4" cy="7" r="3.2" className="lamp-a" />
        <path d="M7 7 H15" className="wire" />
        <circle cx="18" cy="7" r="3.2" className="lamp-b" />
      </svg>
      <span className="brand-name">agentlink</span>
    </div>
  );
}
