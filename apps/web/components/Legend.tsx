import { ROLE_COLORS, type ModeKind, type Role } from "@hive/protocol";

/**
 * What a colour on the map means *in the mode that is on*. The planner reuses the four stem colours
 * for other things — STEREO's two sides, CHOIR's four voices — so a legend that always read
 * "drums · bass · vocals · other" was wrong in every mode but ORCHESTRA: in Choir a cyan phone is a
 * soprano, not vocals. These pairs mirror plan() in @hive/protocol (planner.ts).
 * UNISON, WAVE and STROBE have no entries: every phone plays the whole song there.
 */
const ENTRIES: Record<ModeKind, Array<{ label: string; role: Role }>> = {
  ORCHESTRA: (Object.keys(ROLE_COLORS) as Role[]).map((role) => ({ label: role, role })),
  STEREO: [
    { label: "left", role: "drums" },
    { label: "right", role: "vocals" },
  ],
  CHOIR: [
    { label: "choir", role: "unison" },
    { label: "soprano", role: "vocals" },
    { label: "basso", role: "bass" },
    { label: "tenor", role: "other" },
  ],
  UNISON: [],
  WAVE: [],
  STROBE: [],
};

/**
 * Without `mode` the entries equal Object.keys(ROLE_COLORS) exactly — the map's ground truth for
 * colour meaning.
 *
 * A colour key and nothing else. The line that used to sit beside it ("ring = sync health · drag to
 * place · tap to change part") was instructions for a map that explains itself: a host finds
 * dragging and tapping by touching a dot, and the founder asked for the "drag" hint to go.
 */
export function Legend({
  readOnly = false,
  mode,
}: {
  /** The projector's map: no host marker to explain when the host is a speaker like everyone else. */
  readOnly?: boolean;
  mode?: ModeKind;
}) {
  const entries = ENTRIES[mode ?? "ORCHESTRA"];
  return (
    <div data-testid="map-legend" className="flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: "var(--muted)" }}>
      {entries.map(({ label, role }) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE_COLORS[role] }} />
          {label}
        </span>
      ))}
      {readOnly ? null : (
        <span className="flex items-center gap-1.5">
          <span className="box-border h-2.5 w-2.5 rounded-full border-[1.5px]" style={{ borderColor: "var(--host-ring)" }} />
          Host
        </span>
      )}
    </div>
  );
}
