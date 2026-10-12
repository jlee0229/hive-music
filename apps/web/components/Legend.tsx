import { ROLE_COLORS } from "@hive/protocol";

/**
 * Legend entries must equal Object.keys(ROLE_COLORS) exactly — the map's ground truth for color meaning.
 * The hint line follows what the map actually does: `partsApply` is false when a tap opens a
 * phone's sheet instead of changing its part, `ringHealth` is false when every ring is the calm
 * black of unison (no health colour to explain). Both default to true.
 */
export function Legend({ readOnly = false, partsApply = true, ringHealth = true }: { readOnly?: boolean; partsApply?: boolean; ringHealth?: boolean }) {
  const hint = readOnly
    ? "ring = sync health"
    : [ringHealth ? "ring = sync health" : null, "drag to place", partsApply ? "tap to change part" : "tap a phone for more"].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap gap-3 text-xs" style={{ color: "var(--muted)" }}>
      {(Object.keys(ROLE_COLORS) as Array<keyof typeof ROLE_COLORS>).map((role) => (
        <span key={role} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE_COLORS[role] }} />
          {role}
        </span>
      ))}
      {readOnly ? null : (
        <span className="flex items-center gap-1.5">
          <span className="box-border h-2.5 w-2.5 rounded-full border-[1.5px]" style={{ borderColor: "var(--host-ring)" }} />
          you
        </span>
      )}
      <span className="ml-auto">{hint}</span>
    </div>
  );
}
