import { z } from "zod";
import { BROWSER_FAMILIES, NUDGE_RANGE_MS, ROLES, STEMS } from "./constants";
import { ModeSchema } from "./mode";
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
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const ClientRecordSchema = z.object({
  id: z.string().min(8).max(64),
  kind: z.enum(["host", "player"]),
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
  audioReadyTrackId: z.string().nullable(),
});
export type ClientRecord = z.infer<typeof ClientRecordSchema>;

export const CalibrationResultSchema = z.object({
  residualMs: z.number(),
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
