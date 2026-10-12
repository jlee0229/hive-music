/** Shared room builders for the planner tests. */
import { PROTOCOL_VERSION, STEMS } from "../constants";
import { SILENT_DB } from "../planner";
import { IDLE_CALIBRATION, type Assignment, type ClientRecord, type RoomState } from "../room";

export function client(i: number, over: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: `c${i}-00000000`, kind: "player", plays: true, name: `P${i}`,
    device: { userAgent: "ua", platform: "x", browserFamily: "other" },
    joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0,
    tableLatencyMs: null, calibratedOffsetMs: null, assignment: null, connected: true, audioReadyTrackId: null,
    ...over,
  };
}

export function room(clients: ClientRecord[], mode: RoomState["mode"] = { kind: "UNISON", params: {} }, stems: string[] = [...STEMS], track: Partial<NonNullable<RoomState["track"]>> = {}): RoomState {
  const rec: RoomState["clients"] = {};
  for (const c of clients) rec[c.id] = c;
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t", title: "t", durationSec: 60, stems, ...track }, transport: { state: "stopped" }, mode, scenePlan: null,
    calibration: IDLE_CALIBRATION, clients: rec,
  };
}

/** The stems an assignment makes audible, sorted. */
export const audible = (a: Pick<Assignment, "gainsDb">) => Object.entries(a.gainsDb).filter(([, db]) => db > SILENT_DB).map(([s]) => s).sort();

/** Union of the stems audible on the given clients (connected speakers, by default the whole plan). */
export function heard(plan: Record<string, Assignment | null>, ids?: string[]): string[] {
  const set = new Set<string>();
  for (const [id, a] of Object.entries(plan)) if (a && (!ids || ids.includes(id))) for (const s of audible(a)) set.add(s);
  return [...set].sort();
}
