import { z } from "zod";
import { BROWSER_FAMILIES, MODES, NUDGE_RANGE_MS, ROLES, STEMS } from "./constants";
import { ModeParamsSchema, ModeSchema } from "./mode";
import { PatternSchema } from "./pattern";
import { ScenePlanSchema } from "./scene";

export const PositionSchema = z.object({
  /** Normalized map coordinates: 0..1, origin top-left, y down. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type Position = z.infer<typeof PositionSchema>;

export const DeviceInfoSchema = z.object({
  userAgent: z.string().max(512),
  platform: z.string().max(64),
  browserFamily: z.enum(BROWSER_FAMILIES),
  model: z.string().max(64).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const TrackInfoSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(120),
  durationSec: z.number().positive(),
  /** Stem names in canonical order, e.g. ["drums","bass","vocals","other"]; a plain file is ["mix"]. */
  stems: z.array(z.string().min(1)).min(1).max(6),
  bpm: z.number().positive().optional(),
  /** Beat-grid phase: seconds from track time 0 to the first beat. STROBE switches land here. */
  beatOffsetSec: z.number().min(0).optional(),
});
export type TrackInfo = z.infer<typeof TrackInfoSchema>;

/**
 * THE timeline. `playing`: track position = (serverTime − serverTimeAtTrackZero) / 1000.
 * `paused`: frozen at trackTimeAtPause. `stopped`: nothing loaded into the timeline.
 */
export const TransportSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("stopped") }),
  z.object({ state: z.literal("playing"), serverTimeAtTrackZero: z.number() }),
  z.object({ state: z.literal("paused"), trackTimeAtPause: z.number().min(0) }),
]);
export type Transport = z.infer<typeof TransportSchema>;

/** Roles a host can pin a player to (everything but the synthetic "unison"). */
export const StemRoleSchema = z.enum(STEMS);
export type StemRole = z.infer<typeof StemRoleSchema>;

/** Pure output of plan(room) for one client. Gains are dB per stem; −60 dB = silent. */
export const AssignmentSchema = z.object({
  /** Display label: "drums", "unison", "left", "wave"… */
  label: z.string().max(24),
  /** Which ROLE_COLORS entry the UI paints this phone with. */
  role: z.enum(ROLES),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  gainsDb: z.record(z.string(), z.number().min(-60).max(12)),
  /** Deliberate spatial delay, ms (WAVE). Added to the schedule, never subtracted. */
  delayMs: z.number().min(0).max(1000),
  /** nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0). Positive = this device is late → advance it. */
  compensationMs: z.number(),
  pattern: PatternSchema.nullable(),
  /** If set, apply the new gains/pattern exactly at this server time (scene boundaries). */
  applyAtServerTime: z.number().nullable(),
  /**
   * CHOIR: shift this phone's copy of the song by this many semitones (time-stretched client-side,
   * never a playbackRate change — that would also change speed and break the shared timeline).
   * Absent/0 = play as recorded.
   */
  pitchSemitones: z.number().int().min(-24).max(24).optional(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const ClientRecordSchema = z.object({
  id: z.string().min(8).max(64),
  /** `viewer` is a read-only display (v4): never a speaker, never counted as a player. */
  kind: z.enum(["host", "player", "viewer"]),
  /** Whether this client is a speaker. Hosts default false; players always true. */
  plays: z.boolean(),
  name: z.string().max(32),
  device: DeviceInfoSchema,
  /** Monotonic per-room counter at first join; drives stable role assignment. */
  joinIndex: z.number().int().min(0),
  joinedAtServerTime: z.number(),
  position: PositionSchema.nullable(),
  pinnedRole: StemRoleSchema.nullable(),
  nudgeMs: z.number().min(-NUDGE_RANGE_MS).max(NUDGE_RANGE_MS),
  tableLatencyMs: z.number().nullable(),
  calibratedOffsetMs: z.number().nullable(),
  assignment: AssignmentSchema.nullable(),
  connected: z.boolean(),
  /** Track id this client has fully decoded (all stems), or null. */
  audioReadyTrackId: z.string().max(64).nullable(),
});
export type ClientRecord = z.infer<typeof ClientRecordSchema>;

export const CalibrationResultSchema = z.object({
  /** Finite: this is added to `calibratedOffsetMs`, and an Infinity there serializes as null (see messages.ts). */
  residualMs: z.number().finite(),
  confidence: z.number().min(0).max(1),
});
export const CalibrationStateSchema = z.object({
  state: z.enum(["idle", "countdown", "running", "done", "failed"]),
  referenceClientId: z.string().nullable(),
  startServerTime: z.number().nullable(),
  order: z.array(z.string()),
  results: z.record(z.string(), CalibrationResultSchema),
});
export type CalibrationState = z.infer<typeof CalibrationStateSchema>;
export const IDLE_CALIBRATION: CalibrationState = { state: "idle", referenceClientId: null, startServerTime: null, order: [], results: {} };

export const RoomStateSchema = z.object({
  code: z.string().min(3).max(8),
  protocolVersion: z.number().int(),
  createdAtServerTime: z.number(),
  hostClientIds: z.array(z.string()),
  track: TrackInfoSchema.nullable(),
  transport: TransportSchema,
  mode: ModeSchema,
  scenePlan: ScenePlanSchema.nullable(),
  calibration: CalibrationStateSchema,
  clients: z.record(z.string(), ClientRecordSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

/**
 * RoomState **as a client reads it off the wire** — the same shape and the same TypeScript type as
 * `RoomStateSchema`, but forgiving about values a *newer* server may send that this bundle has never
 * heard of.
 *
 * Why it exists: web (Vercel) and server (Fly) deploy at different times and phones keep a tab open for
 * hours, so an old bundle talking to a new server is the normal state of the world for a while after
 * every deploy. A ROOM_STATE is one zod parse; with the strict schema a single unknown enum value
 * anywhere in it makes the phone drop the whole snapshot, silently, and keep dropping them. That is what
 * adding the CHOIR mode did to every tab that predated it: the moment a host picked CHOIR (or a vibe
 * plan merely *contained* a CHOIR scene) those phones stopped receiving track changes, transport and
 * assignments until the mode changed back — and PROTOCOL_VERSION had not moved, so nothing told them
 * to reload.
 *
 * So, on receive only: an unknown mode reads as UNISON (the phone's own `assignment` — gains, delay,
 * pattern — still comes from the server and is still applied), out-of-range mode params read as {},
 * an unparsable scene plan as none, an unknown client kind as a viewer, an unknown role as `unison`, an
 * unknown pattern as no pattern (audible, ungated), an unknown browser family as `other`. Everything a
 * phone needs in order to keep playing in time stays strict. The server keeps producing against the
 * strict `RoomStateSchema`; tests validate against the strict one.
 */
const WireAssignmentSchema = AssignmentSchema.extend({
  role: z.enum(ROLES).catch("unison"),
  pattern: PatternSchema.nullable().catch(null),
});
const WireClientRecordSchema = ClientRecordSchema.extend({
  kind: z.enum(["host", "player", "viewer"]).catch("viewer"),
  device: DeviceInfoSchema.extend({ browserFamily: z.enum(BROWSER_FAMILIES).catch("other") }),
  assignment: WireAssignmentSchema.nullable(),
});
export const RoomStateWireSchema = RoomStateSchema.extend({
  mode: z.object({ kind: z.enum(MODES).catch("UNISON"), params: ModeParamsSchema.catch({}) }),
  scenePlan: ScenePlanSchema.nullable().catch(null),
  clients: z.record(z.string(), WireClientRecordSchema),
});

/** Track position in seconds for a transport at a given server time (0 when stopped). */
export function trackTimeSec(transport: Transport, serverTime: number): number {
  switch (transport.state) {
    case "playing":
      return Math.max(0, (serverTime - transport.serverTimeAtTrackZero) / 1000);
    case "paused":
      return transport.trackTimeAtPause;
    default:
      return 0;
  }
}

/** Clients that are speakers: every player, plus hosts that opted in. Disconnected ones keep their slot (retention window). */
export function speakerClients(room: RoomState): ClientRecord[] {
  return Object.values(room.clients).filter((c) => c.plays);
}
