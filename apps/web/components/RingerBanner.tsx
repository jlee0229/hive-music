/** iOS Safari mutes Web Audio when the ringer switch is off. Shown only for that one browser family. */
export function RingerBanner() {
  return (
    <div
      className="flex gap-3 rounded-2xl border p-3.5"
      style={{ background: "var(--ringer-bg)", borderColor: "var(--ringer-border)" }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--ringer-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: "var(--ringer-fg)" }}>
          Ringer on, please
        </span>
        <span className="text-[13px] leading-snug" style={{ color: "#cbb27a" }}>
          Silent mode mutes web audio. Flip the side switch.
        </span>
      </div>
    </div>
  );
}
