import { ROLE_COLORS } from "@hive/protocol";

/** Legend entries must equal Object.keys(ROLE_COLORS) exactly — the map's ground truth for color meaning. */
export function Legend({ readOnly = false }: { readOnly?: boolean }) {
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
      <span className="ml-auto">{readOnly ? "ring = sync health" : "ring = sync health · drag to place · tap to change part"}</span>
    </div>
  );
}
