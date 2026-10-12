import { CHOIR_STEPS, ROLE_COLORS, STEMS, WAVE_SWELL_PERIOD_MS, type Role } from "./constants";
import { speakerLayout } from "./layout";
import { resolveModeParams } from "./mode";
import type { Assignment, ClientRecord, Position, RoomState, StemRole } from "./room";

export const SILENT_DB = -60;

/** Positive = device is late → the client advances its schedule by this much. */
export function compensationMs(c: Pick<ClientRecord, "nudgeMs" | "calibratedOffsetMs" | "tableLatencyMs">): number {
  return c.nudgeMs + (c.calibratedOffsetMs ?? c.tableLatencyMs ?? 0);
}

export function roleForStem(stem: string): Role {
  return (STEMS as readonly string[]).includes(stem) ? (stem as Role) : "unison";
}

function stemRoles(room: RoomState): StemRole[] {
  const stems = room.track?.stems ?? ["mix"];
  return STEMS.filter((s) => stems.includes(s));
}

function allStems(room: RoomState): string[] {
  return room.track?.stems ?? ["mix"];
}

function gains(room: RoomState, audible: readonly string[]): Record<string, number> {
  const trims = room.mode.params?.stemGainsDb ?? {};
  const out: Record<string, number> = {};
  for (const s of allStems(room)) {
    const base = audible.includes(s) ? 0 : SILENT_DB;
    out[s] = base === SILENT_DB ? SILENT_DB : Math.max(SILENT_DB, base + (trims[s] ?? 0));
  }
  return out;
}

const byJoin = (a: ClientRecord, b: ClientRecord) => a.joinIndex - b.joinIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The speakers that are actually making sound right now: connected ones. Coverage rules ("every stem is
 * audible somewhere") count only these — a phone in a pocket with its screen locked keeps its record for
 * the retention window, but it is not covering anything. With nobody connected, everyone counts.
 */
function presentSpeakers(speakers: ClientRecord[]): ClientRecord[] {
  const connected = speakers.filter((c) => c.connected);
  return connected.length > 0 ? connected : speakers;
}

/**
 * Hands `options` out to `clients` (already in priority order) so the counts stay balanced: each client
 * takes the least-used option, and among equals the one its own joinIndex points at, rotating from
 * there. Earlier clients never depend on later ones — a joiner cannot reshuffle anyone — and because the
 * tie-break is the client's own joinIndex rather than its rank, a leaver moves only the clients that
 * have to move to restore the balance. `counts` is pre-seeded by the caller (pins).
 */
function dealBalanced<T extends string | number>(clients: ClientRecord[], options: readonly T[], counts: Map<T, number>): Map<string, T> {
  const out = new Map<string, T>();
  for (const c of clients) {
    let best: T | null = null;
    for (let i = 0; i < options.length; i++) {
      const o = options[(c.joinIndex + i) % options.length]!;
      if (best === null || (counts.get(o) ?? 0) < (counts.get(best) ?? 0)) best = o;
    }
    if (best === null) break;
    counts.set(best, (counts.get(best) ?? 0) + 1);
    out.set(c.id, best);
  }
  return out;
}

/**
 * The order ORCHESTRA hands instruments out in: rhythm and melody alternate, so any two phones that
 * joined back to back get one of each and the band splits into halves that make sense on their own.
 */
const ORCHESTRA_ORDER: readonly StemRole[] = ["drums", "vocals", "bass", "other"];
/** The stem a lone instrument is folded together with when there are fewer phones than stems. */
const STEM_PARTNER: Record<string, string> = { drums: "bass", bass: "drums", vocals: "other", other: "vocals" };

export interface OrchestraSeat {
  /** The instrument this phone is: its label, role and colour. null when the track has no real stems. */
  primary: StemRole | null;
  /** Every stem this phone plays: the primary first, then anything folded onto it. */
  stems: string[];
}

/**
 * ORCHESTRA's arrangement. The promise is that **the whole song is always in the room**:
 *
 *  - every phone is one instrument (its *primary*): a pin if the host set one, otherwise dealt out
 *    balanced in `ORCHESTRA_ORDER`, so N > stems doubles instruments evenly and joiners never move anyone;
 *  - a stem that no connected phone has as its primary is *folded* onto a connected, unpinned phone —
 *    onto its rhythm/melody partner when there is one, else onto whoever is playing the least. One phone
 *    alone plays everything; two play drums+bass / vocals+other; three play drums+bass / vocals / other;
 *    and when the drums phone drops off the Wi-Fi, the bass phone carries drums until it is back;
 *  - a pinned phone plays exactly its pin and is never folded onto. Pin every phone and the host has
 *    chosen what the room hears.
 */
export function arrangeOrchestra(room: RoomState): Map<string, OrchestraSeat> {
  const stems = allStems(room);
  const roles = ORCHESTRA_ORDER.filter((r) => stems.includes(r));
  const speakers = Object.values(room.clients).filter((c) => c.plays).sort(byJoin);
  const seats = new Map<string, OrchestraSeat>();
  if (roles.length === 0) {
    for (const c of speakers) seats.set(c.id, { primary: null, stems: [...stems] });
    return seats;
  }
  const pinOf = (c: ClientRecord) => (c.pinnedRole && roles.includes(c.pinnedRole) ? c.pinnedRole : null);
  const counts = new Map<StemRole, number>();
  for (const c of speakers) {
    const pin = pinOf(c);
    if (pin) counts.set(pin, (counts.get(pin) ?? 0) + 1);
  }
  const dealt = dealBalanced(speakers.filter((c) => !pinOf(c)), roles, counts);
  for (const c of speakers) {
    const primary = pinOf(c) ?? dealt.get(c.id)!;
    seats.set(c.id, { primary, stems: [primary] });
  }

  const present = presentSpeakers(speakers);
  const covered = new Set<string>(present.map((c) => seats.get(c.id)!.primary!));
  const carriers = present.filter((c) => !pinOf(c));
  if (carriers.length > 0) {
    for (const stem of stems) {
      if (covered.has(stem)) continue;
      const partner = carriers.find((c) => seats.get(c.id)!.primary === STEM_PARTNER[stem]);
      const fewest = carriers.reduce((a, b) => (seats.get(b.id)!.stems.length < seats.get(a.id)!.stems.length ? b : a));
      seats.get((partner ?? fewest).id)!.stems.push(stem);
    }
  }
  return seats;
}

/** "drums", "drums + bass", "unison" (everything) — what the phone's screen says it is playing. */
function orchestraLabel(seat: OrchestraSeat, stems: readonly string[]): string {
  if (seat.primary === null || stems.every((s) => seat.stems.includes(s))) return "unison";
  const names = stems.filter((s) => seat.stems.includes(s)); // track order, not fold order
  const label = names.join(" + ");
  return label.length <= 24 ? label : `${seat.primary} + ${names.length - 1}`;
}

/**
 * Projection of a client's position on the mode axis, 0..1. `at` is the client's effective position —
 * its auto-layout slot when the host has not placed it (see layout.ts); without one, the middle.
 */
export function projection(c: ClientRecord, axis: "x" | "y", at: Position | null = c.position): number {
  const p = at ?? c.position;
  if (!p) return 0.5;
  return axis === "x" ? p.x : p.y;
}

function base(c: ClientRecord, label: string, role: Role, gainsDb: Record<string, number>, applyAt: number | null): Assignment {
  return { label, role, color: ROLE_COLORS[role], gainsDb, delayMs: 0, compensationMs: compensationMs(c), pattern: null, applyAtServerTime: applyAt };
}

/**
 * plan(room) → assignment per client id. Pure and deterministic:
 * - hosts with plays=false get null (they are controllers, not speakers);
 * - a joiner never changes which instrument / group / voice an existing client is (joinIndex is
 *   monotonic and every deal is made in joinIndex order); it can only take load *off* them;
 * - the whole song stays in the room: ORCHESTRA and STEREO fold stems nobody present is covering;
 * - pins always win; UNISON = every stem at 0 dB; a "mix"-only track collapses every mode to unison gains.
 */
export function plan(room: RoomState, applyAtServerTime: number | null = null): Record<string, Assignment | null> {
  const out: Record<string, Assignment | null> = {};
  const roles = stemRoles(room);
  const orchestra = room.mode.kind === "ORCHESTRA" ? arrangeOrchestra(room) : null;
  const stems = allStems(room);
  const p = resolveModeParams(room.mode);
  const clients = Object.values(room.clients).sort((a, b) => a.joinIndex - b.joinIndex);
  // Spatial modes read every speaker's *effective* position: where the host dragged it, or the shared
  // auto-layout slot the Hive Map draws it at. Never "unplaced = the middle" — that made WAVE a no-op.
  const spatial = room.mode.kind === "WAVE" || room.mode.kind === "STEREO";
  const where: Record<string, Position> = spatial ? speakerLayout(room).positions : {};
  const at = (c: ClientRecord): Position | null => (Object.hasOwn(where, c.id) ? where[c.id]! : c.position);
  const isLeft = (c: ClientRecord) => projection(c, "x", at(c)) < 0.5;
  const present = presentSpeakers(clients.filter((c) => c.plays));
  const stereoSplit = present.some(isLeft) && present.some((c) => !isLeft(c));

  for (const c of clients) {
    if (!c.plays) {
      out[c.id] = null;
      continue;
    }
    switch (room.mode.kind) {
      case "ORCHESTRA": {
        const seat = orchestra!.get(c.id)!;
        const label = orchestraLabel(seat, stems);
        const role = label === "unison" ? "unison" : roleForStem(seat.primary!);
        out[c.id] = base(c, label, role, gains(room, seat.stems), applyAtServerTime);
        break;
      }
      case "STEREO": {
        // zone-based stem grouping: left = drums+bass, right = vocals+other, by which half of the map
        // the dot is in (auto-layout slots alternate sides, so an untouched room still splits evenly)
        const left = isLeft(c);
        // Half a song is worse than no effect: until there is a connected speaker on BOTH sides (one
        // phone alone, or every dot dragged to the same half), everyone plays the full mix.
        if (!stereoSplit) { out[c.id] = base(c, "unison", "unison", gains(room, stems), applyAtServerTime); break; }
        const group = left ? ["drums", "bass"] : ["vocals", "other"];
        const audible = roles.length ? group.filter((s) => roles.includes(s as StemRole)) : stems;
        out[c.id] = base(c, left ? "left" : "right", left ? "drums" : "vocals", gains(room, audible.length ? audible : stems), applyAtServerTime);
        break;
      }
      case "WAVE": {
        const proj = projection(c, p.axis, at(c));
        const a = base(c, "wave", "unison", gains(room, stems), applyAtServerTime);
        a.delayMs = Math.round(p.spanMs * proj);
        a.pattern = { kind: "wave", periodMs: WAVE_SWELL_PERIOD_MS, phaseMs: Math.round(proj * WAVE_SWELL_PERIOD_MS) };
        out[c.id] = a;
        break;
      }
      case "STROBE": {
        const group = c.joinIndex % p.groups;
        const role = STEMS[group % STEMS.length]!;
        const a = base(c, `strobe ${group + 1}`, role, gains(room, stems), applyAtServerTime);
        // Beat-locked when the track's tempo is known: each group is audible for beatsPerSwitch
        // beats and a full rotation of all groups is groups·beatsPerSwitch beats; duty 1/groups
        // hands the song from group to group with no overlap and no gap. Patterns evaluate on
        // track time, so beat 0 sits at track zero. No bpm → the free-running period, as before.
        const beatMs = room.track?.bpm ? 60000 / room.track.bpm : null;
        const periodMs = beatMs ? Math.min(8000, Math.max(100, Math.round(beatMs * p.beatsPerSwitch * p.groups))) : p.periodMs;
        const duty = beatMs ? 1 / p.groups : p.duty;
        // Anchor the whole rotation to the song's beat grid: switches land ON the drum hits, not
        // wherever track time 0 happened to fall inside the bar (intros and pickups shift it).
        const gridMs = beatMs ? Math.round((room.track?.beatOffsetSec ?? 0) * 1000) : 0;
        a.pattern = { kind: "strobe", periodMs, phaseMs: gridMs + Math.round((group / p.groups) * periodMs), duty, rampMs: 10 };
        out[c.id] = a;
        break;
      }
      case "CHOIR": {
        // Everyone plays the full mix, but each phone sings at its own pitch: octaves and a fifth
        // rotated by joinIndex, so the crowd stacks back into one consonant chord. The shift itself
        // happens client-side (time-stretch + resample), keeping the shared timeline untouched.
        const step = CHOIR_STEPS[c.joinIndex % CHOIR_STEPS.length]!;
        const label = step === 0 ? "choir" : step === 12 ? "soprano" : step === -12 ? "basso" : "tenor";
        const role = step === 0 ? "unison" : step === 12 ? "vocals" : step === -12 ? "bass" : "other";
        const a = base(c, label, role, gains(room, stems), applyAtServerTime);
        a.pitchSemitones = step;
        out[c.id] = a;
        break;
      }
      case "UNISON":
      default:
        out[c.id] = base(c, "unison", "unison", gains(room, stems), applyAtServerTime);
    }
  }
  return out;
}

/** Convenience: returns a copy of the room with every client's `assignment` refreshed. */
export function withAssignments(room: RoomState, applyAtServerTime: number | null = null): RoomState {
  const assignments = plan(room, applyAtServerTime);
  const clients: RoomState["clients"] = {};
  // Own keys only: `assignments["toString"]` on a plain object is a function, not a missing entry.
  for (const [id, c] of Object.entries(room.clients)) clients[id] = { ...c, assignment: Object.hasOwn(assignments, id) ? (assignments[id] ?? null) : null };
  return { ...room, clients };
}
