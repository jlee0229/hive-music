import { z } from "zod";
import { MAX_PLAYERS, NUDGE_RANGE_MS, MODES } from "./constants";
import { ModeParamsSchema } from "./mode";
import { CalibrationResultSchema, DeviceInfoSchema, RoomStateWireSchema, StemRoleSchema } from "./room";

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

/**
 * A number a client may send. `z.number()` alone accepts ±Infinity, and `1e999` is valid JSON that
 * `JSON.parse` turns into exactly that; `JSON.stringify` then writes it back out as `null`. So an
 * Infinity that reaches room state (an `outputLatencyMs` used as a calibration base, a SEEK target)
 * leaves the server as `"compensationMs":null` and fails the schema on every phone. Fields with both
 * a min and a max are already safe; everything else a client can send goes through this.
 */
const finite = () => z.number().finite();

export const AudioStateSchema = z.enum(["locked", "unlocked", "loading", "ready"]);

/**
 * Client ids are used as keys of plain objects everywhere (`room.clients[id]`, `calibration.results[id]`,
 * the planner's output map), so an id that names an `Object.prototype` member is not an id, it is an
 * attack: `room.clients["toString"]` is a function, which the join path took for an existing record and
 * re-stored without `id`/`kind`/`plays` — and one such record makes every later `ROOM_STATE` fail
 * `RoomStateSchema` on every phone in the room. `__proto__` is worse (it writes through to the
 * prototype). Refusing them here covers the real server and the mock at once, because both only ever see
 * a message that passed `parseClientMessage`.
 */
const notReserved = (s: string) => !(s in Object.prototype);
const RESERVED_ID = { message: "reserved id" };
/** The id a client joins with: a UUID in practice (8..64 chars). */
export const ClientIdSchema = z.string().min(8).max(64).refine(notReserved, RESERVED_ID);
/** A reference to some client inside a control message. An unknown id is a no-op, so no minimum. */
export const ClientRefSchema = z.string().max(64).refine(notReserved, RESERVED_ID);

/** One measurement per speaker, with headroom over MAX_PLAYERS for hosts that also play. */
export const MAX_CALIBRATION_MEASUREMENTS = MAX_PLAYERS * 4;

// ---- client → server --------------------------------------------------------
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("JOIN"),
    /** Client-generated UUID kept in localStorage; the same id on reconnect restores the slot. */
    clientId: ClientIdSchema,
    roomCode: z.string().min(3).max(8),
    /**
     * `viewer` (v4) is a read-only join for `/screen`: no speaker role, not counted as a player, no
     * `hostKey`, and no control messages — but it receives `ROOM_STATE` *and* `HEALTH`, which is the whole
     * point (a projector display shows the room's median sync). The server forces `plays: false` for it
     * whatever the field says, and never adds it to `hostClientIds`, so the credential a venue display
     * would otherwise need — and a leaked `hostKey` is full control, including `KICK` — is not required.
     */
    kind: z.enum(["host", "player", "viewer"]),
    /** Hosts: false unless "use this phone as a speaker too". Players: must be true. */
    plays: z.boolean(),
    hostKey: z.string().max(64).optional(),
    /**
     * Hosts only, optional: a random secret this browser keeps (`hive:libraryKey`) that says whose
     * uploaded songs this hive may see. The server stores only a hash of it on the room and never
     * broadcasts it. Uploads made from this hive are owned by it; the hive's song list and playlist
     * rotation are the shared built-in library plus this owner's uploads — never a stranger's.
     * Ignored unless the JOIN also carries the room's hostKey. Additive: old clients omit it and
     * get the shared library only.
     */
    libraryKey: z.string().min(16).max(64).optional(),
    name: z.string().max(32).optional(),
    device: DeviceInfoSchema,
    protocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal("NTP_REQUEST"),
    t0: finite(),
    probeGroupId: z.number().int().optional(),
    probeGroupIndex: z.union([z.literal(0), z.literal(1)]).optional(),
  }),
  z.object({ type: z.literal("SET_TRACK"), trackId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal("TRANSPORT"),
    action: z.enum(["PLAY", "PAUSE", "SEEK"]),
    trackTimeSec: finite().min(0).optional(),
  }),
  z.object({ type: z.literal("SET_MODE"), mode: z.enum(MODES), params: ModeParamsSchema.default({}) }),
  z.object({ type: z.literal("ASSIGN"), clientId: ClientRefSchema, role: StemRoleSchema.nullable() }),
  z.object({ type: z.literal("SET_POSITION"), clientId: ClientRefSchema, x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  z.object({ type: z.literal("NUDGE"), clientId: ClientRefSchema, nudgeMs: z.number().min(-NUDGE_RANGE_MS).max(NUDGE_RANGE_MS) }),
  z.object({ type: z.literal("SET_PLAYS"), plays: z.boolean() }),
  z.object({ type: z.literal("KICK"), clientId: ClientRefSchema }),
  /**
   * `trackId` is stored on the sender's record and re-broadcast in every ROOM_STATE, by any player:
   * unbounded, one phone could make the server fan megabytes out to the whole room twice a second.
   * Same bound as `TrackInfo.id`.
   */
  z.object({ type: z.literal("AUDIO_READY"), trackId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal("CLIENT_STATUS"),
    rttMs: finite().nullable(),
    syncErrMs: finite().nullable(),
    outputLatencyMs: finite().nullable(),
    audioState: AudioStateSchema,
  }),
  z.object({ type: z.literal("CALIBRATION_START"), referenceClientId: ClientRefSchema }),
  /**
   * Abandon a tuning moment in progress (host only, no fields). The server returns
   * `room.calibration` to IDLE_CALIBRATION and stops scheduling; because clicks are handed out up
   * front as SCHEDULED_ACTIONs, each *client* drops its own pending clicks when it sees the idle
   * state — there is nothing to un-send. A cancelled run writes no `calibratedOffsetMs`.
   */
  z.object({ type: z.literal("CALIBRATION_CANCEL") }),
  /**
   * Throw away measured offsets (host only). `clientId` clears one client, omitting it clears every
   * client in the room. This is the undo for a tuning moment that measured the wrong thing — a phone
   * in a pocket, a click confidently matched to a sidelobe — and it must be a *distinct* operation
   * from re-running calibration, because a bad `calibratedOffsetMs` is the accumulation base for the
   * next run (see docs/04-calibration.md): re-calibrating on top of a wrong offset keeps the error.
   *
   * Clearing sets `calibratedOffsetMs` back to `null`, not to `0`. Null means "no measurement", which
   * falls back through the Tier-1 table; zero would be a claim that this phone has no output latency,
   * which is never true.
   *
   * **Refused while a run is in flight** (`calibration.state !== "idle"`) with `ERROR` code
   * `CALIBRATION_BUSY`: the reference measures residuals against the compensation the phones were
   * applying *at click time*, so clearing the base between the clicks and the report would add those
   * residuals to a different base and bake in the error the reset was meant to remove. Cancel first,
   * then reset. Otherwise idempotent, and it never touches `room.calibration`.
   */
  z.object({ type: z.literal("CALIBRATION_RESET"), clientId: ClientRefSchema.optional() }),
  z.object({
    type: z.literal("CALIBRATION_REPORT"),
    measurements: z.array(CalibrationResultSchema.extend({ clientId: ClientRefSchema })).min(1).max(MAX_CALIBRATION_MEASUREMENTS),
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
  // the forgiving read-side schema: an old tab must survive a newer server (see RoomStateWireSchema)
  z.object({ type: z.literal("ROOM_STATE"), room: RoomStateWireSchema }),
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
