import { z } from "zod";
import { NUDGE_RANGE_MS, MODES } from "./constants";
import { ModeParamsSchema } from "./mode";
import { CalibrationResultSchema, DeviceInfoSchema, RoomStateSchema, StemRoleSchema } from "./room";

// ---- calibration click signal ----------------------------------------------
/** Synthesized in sync-client (never a fixture): a short burst followed by a linear chirp. */
export const ClickSpecSchema = z.object({
  kind: z.literal("click"),
  burstMs: z.number().positive(),
  chirpFromHz: z.number().positive(),
  chirpToHz: z.number().positive(),
  chirpMs: z.number().positive(),
  gain: z.number().min(0).max(1),
});
export type ClickSpec = z.infer<typeof ClickSpecSchema>;
export const DEFAULT_CLICK_SPEC: ClickSpec = { kind: "click", burstMs: 2, chirpFromHz: 2000, chirpToHz: 6000, chirpMs: 20, gain: 0.8 };

export const AudioStateSchema = z.enum(["locked", "unlocked", "loading", "ready"]);

// ---- client → server --------------------------------------------------------
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("JOIN"),
    /** Client-generated UUID kept in localStorage; the same id on reconnect restores the slot. */
    clientId: z.string().min(8).max(64),
    roomCode: z.string().min(3).max(8),
    kind: z.enum(["host", "player"]),
    /** Hosts: false unless "use this phone as a speaker too". Players: must be true. */
    plays: z.boolean(),
    hostKey: z.string().max(64).optional(),
    name: z.string().max(32).optional(),
    device: DeviceInfoSchema,
    protocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal("NTP_REQUEST"),
    t0: z.number(),
    probeGroupId: z.number().int().optional(),
    probeGroupIndex: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  z.object({ type: z.literal("SET_TRACK"), trackId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal("TRANSPORT"),
    action: z.enum(["PLAY", "PAUSE", "SEEK"]),
    trackTimeSec: z.number().min(0).optional(),
  }),
  z.object({ type: z.literal("SET_MODE"), mode: z.enum(MODES), params: ModeParamsSchema.default({}) }),
  z.object({ type: z.literal("ASSIGN"), clientId: z.string(), role: StemRoleSchema.nullable() }),
  z.object({ type: z.literal("SET_POSITION"), clientId: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({ type: z.literal("NUDGE"), clientId: z.string(), nudgeMs: z.number().min(-NUDGE_RANGE_MS).max(NUDGE_RANGE_MS) }),
  z.object({ type: z.literal("SET_PLAYS"), plays: z.boolean() }),
  z.object({ type: z.literal("KICK"), clientId: z.string() }),
  z.object({ type: z.literal("AUDIO_READY"), trackId: z.string() }),
  z.object({
    type: z.literal("CLIENT_STATUS"),
    rttMs: z.number().nullable(),
    syncErrMs: z.number().nullable(),
    outputLatencyMs: z.number().nullable(),
    audioState: AudioStateSchema,
  }),
  z.object({ type: z.literal("CALIBRATION_START"), referenceClientId: z.string() }),
  z.object({
    type: z.literal("CALIBRATION_REPORT"),
    measurements: z.array(CalibrationResultSchema.extend({ clientId: z.string() })).min(1),
  }),
  z.object({ type: z.literal("PONG") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

// ---- server → client --------------------------------------------------------
export const HealthSnapshotSchema = z.object({
  rttMs: z.number().nullable(),
  syncErrMs: z.number().nullable(),
  outputLatencyMs: z.number().nullable(),
  audioState: AudioStateSchema,
  lastSeenServerTime: z.number(),
});
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

export const ScheduledActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CALIBRATION_CLICK"), clickId: z.string(), clickSpec: ClickSpecSchema }),
]);
export type ScheduledAction = z.infer<typeof ScheduledActionSchema>;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("WELCOME"),
    clientId: z.string(),
    roomCode: z.string(),
    serverTime: z.number(),
    protocolVersion: z.number().int(),
    isHost: z.boolean(),
  }),
  z.object({
    type: z.literal("NTP_RESPONSE"),
    t0: z.number(),
    t1: z.number(),
    t2: z.number(),
    probeGroupId: z.number().int().optional(),
    probeGroupIndex: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  z.object({ type: z.literal("ROOM_STATE"), room: RoomStateSchema }),
  z.object({ type: z.literal("HEALTH"), serverTime: z.number(), clients: z.record(z.string(), HealthSnapshotSchema) }),
  z.object({ type: z.literal("SCHEDULED_ACTION"), serverTimeToExecute: z.number(), action: ScheduledActionSchema }),
  z.object({
    type: z.literal("CALIBRATION_PLAN"),
    startServerTime: z.number(),
    intervalMs: z.number().positive(),
    order: z.array(z.string()),
    clickSpec: ClickSpecSchema,
  }),
  z.object({ type: z.literal("PING"), serverTime: z.number() }),
  z.object({ type: z.literal("ERROR"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage["type"];

export const CLIENT_MESSAGE_TYPES = ClientMessageSchema.options.map((o) => o.shape.type.value) as ClientMessageType[];
export const SERVER_MESSAGE_TYPES = ServerMessageSchema.options.map((o) => o.shape.type.value) as ServerMessageType[];

export function parseClientMessage(raw: unknown): ClientMessage | null {
  const data = typeof raw === "string" ? safeJson(raw) : raw;
  const r = ClientMessageSchema.safeParse(data);
  return r.success ? r.data : null;
}
export function parseServerMessage(raw: unknown): ServerMessage | null {
  const data = typeof raw === "string" ? safeJson(raw) : raw;
  const r = ServerMessageSchema.safeParse(data);
  return r.success ? r.data : null;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
