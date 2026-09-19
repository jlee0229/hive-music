import { ROLE_COLORS, STEMS, WAVE_SWELL_PERIOD_MS, type Role } from "./constants";
import { resolveModeParams } from "./mode";
import type { Assignment, ClientRecord, RoomState, StemRole } from "./room";

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

/** Stable per-client stem choice: pinned role wins, else joinIndex modulo the stem count. */
export function stemForClient(c: ClientRecord, roles: StemRole[]): StemRole | null {
  if (roles.length === 0) return null;
  if (c.pinnedRole && roles.includes(c.pinnedRole)) return c.pinnedRole;
  return roles[c.joinIndex % roles.length]!;
}

/** Projection of a client's position on the mode axis, 0..1; unplaced clients sit in the middle. */
export function projection(c: ClientRecord, axis: "x" | "y"): number {
  if (!c.position) return 0.5;
  return axis === "x" ? c.position.x : c.position.y;
}

function base(c: ClientRecord, label: string, role: Role, gainsDb: Record<string, number>, applyAt: number | null): Assignment {
  return { label, role, color: ROLE_COLORS[role], gainsDb, delayMs: 0, compensationMs: compensationMs(c), pattern: null, applyAtServerTime: applyAt };
}

/**
 * plan(room) → assignment per client id. Pure and deterministic:
 * - hosts with plays=false get null (they are controllers, not speakers);
 * - existing clients never reshuffle when someone joins (joinIndex is monotonic);
 * - pins always win; UNISON = every stem at 0 dB; a "mix"-only track collapses every mode to unison gains.
 */
export function plan(room: RoomState, applyAtServerTime: number | null = null): Record<string, Assignment | null> {
  const out: Record<string, Assignment | null> = {};
  const roles = stemRoles(room);
  const stems = allStems(room);
  const p = resolveModeParams(room.mode);
  const clients = Object.values(room.clients).sort((a, b) => a.joinIndex - b.joinIndex);

  for (const c of clients) {
    if (!c.plays) {
      out[c.id] = null;
      continue;
    }
    switch (room.mode.kind) {
      case "ORCHESTRA": {
        const stem = stemForClient(c, roles);
        if (!stem) { out[c.id] = base(c, "unison", "unison", gains(room, stems), applyAtServerTime); break; }
        out[c.id] = base(c, stem, roleForStem(stem), gains(room, [stem]), applyAtServerTime);
        break;
      }
      case "STEREO": {
        // zone-based stem grouping: left = drums+bass, right = vocals+other; unplaced → alternate by joinIndex
        const left = c.position ? c.position.x < 0.5 : c.joinIndex % 2 === 0;
        const group = left ? ["drums", "bass"] : ["vocals", "other"];
        const audible = roles.length ? group.filter((s) => roles.includes(s as StemRole)) : stems;
        out[c.id] = base(c, left ? "left" : "right", left ? "drums" : "vocals", gains(room, audible.length ? audible : stems), applyAtServerTime);
        break;
      }
      case "WAVE": {
        const proj = projection(c, p.axis);
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
        a.pattern = { kind: "strobe", periodMs: p.periodMs, phaseMs: Math.round((group / p.groups) * p.periodMs), duty: p.duty, rampMs: 10 };
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
  for (const [id, c] of Object.entries(room.clients)) clients[id] = { ...c, assignment: assignments[id] ?? null };
  return { ...room, clients };
}
