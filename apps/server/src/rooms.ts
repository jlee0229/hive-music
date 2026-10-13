// Room manager: a port of packages/protocol/src/mock-server.ts's single scenario room into a real,
// multi-room, in-memory Bun.serve server. Same schemas, same planner (withAssignments), same rates.
import {
  CALIBRATION_CLICK_INTERVAL_MS,
  CALIBRATION_COUNTDOWN_MS,
  DISCONNECT_RETENTION_MS,
  DEFAULT_CLICK_SPEC,
  HEALTH_HZ,
  IDLE_CALIBRATION,
  LEAD_MS,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_IDLE_TTL_MS,
  ROOM_STATE_MAX_HZ,
  STARTER_LATENCY_TABLE_MS,
  TRACK_ADVANCE_LEAD_MS,
  currentScene,
  loopRestartZero,
  nextInRotation,
  nextScene,
  parseClientMessage,
  trackTimeSec,
  withAssignments,
  type AudioState,
  type ClientMessage,
  type ClientRecord,
  type RoomState,
  type ScenePlan,
  type ServerMessage,
  type TrackInfo,
} from "@hive/protocol";
import { loadLibrary, ownerIdOf, visibleLibrary, type LibraryEntry, type LibraryScope } from "./library";
import { HostKeys, safeEqual } from "./host-key";
import { RateLimiter } from "./rate-limit";

const now = () => performance.timeOrigin + performance.now();

/**
 * Hard ceiling on client records in one room (connected or retained). Not the product limit — that
 * is MAX_PLAYERS (64) and nothing enforces it yet — but the point past which a room is certainly
 * under attack: ROOM_STATE grows ~520 bytes per record and goes to every phone at up to 2 Hz, so an
 * unbounded room is an amplifier that takes the whole process down (audit SG-04).
 */
export const MAX_ROOM_CLIENTS = 256;
/** Identity-less read-only sockets per room (Room.observe). */
export const MAX_ROOM_OBSERVERS = 8;

/**
 * A room nobody has joined yet lives this long. The idle timer used to be armed only when the last
 * client record expired, so a room that never had a client never had a timer: every POST /rooms
 * leaked a room and two intervals for the life of the process (audit SG-06). Short is safe — a host
 * whose first JOIN arrives later than this simply re-creates the room with its signed key (SG-01).
 */
export const ROOM_UNCLAIMED_TTL_MS = 120_000;

/**
 * Restart recovery for guests (audit SG-15). After a deploy every phone reconnects within the same
 * second, and whether a guest's JOIN lands before or after the host's is a coin flip. Before the
 * host's, the room does not exist yet: the guest got NO_ROOM, and the client never asks again — so
 * each restart silently dropped about half the party. For a short while after boot, a JOIN for a
 * room that is not there is therefore held instead of refused; when the host's signed key brings
 * the room back, the held JOINs are admitted as if nothing had happened.
 */
export const RESTART_GRACE_MS = 120_000; // how long after boot a missing room may still be on its way back
export const JOIN_PARK_MS = 15_000; // how long one JOIN waits for it before the usual NO_ROOM
export const MAX_PARKED_JOINS = 1000; // process-wide; past this a miss is answered at once

/** Rooms alive at once, process-wide. Far above real use; the point is that the number is finite. */
export const MAX_ROOMS = 2000;

/**
 * What the wire schema lets through but the room cannot afford to store (audit SG-05). Everything a
 * client sends that lands in RoomState is re-broadcast to every phone, so one bad value is a
 * room-wide problem:
 *  - `z.number()` accepts Infinity, and JSON can carry it (`1e999`). JSON.stringify turns it into
 *    `null`, which fails RoomStateSchema on every client — one such value in `transport` or a
 *    client's `calibratedOffsetMs` and no phone in the room can read a ROOM_STATE again.
 *  - several strings have no length limit (`AUDIO_READY.trackId`, `CALIBRATION_START.referenceClientId`,
 *    `stemGainsDb` keys): megabytes from any guest, stored and re-sent to everyone at up to 2 Hz.
 * The longest legitimate string in any ClientMessage is DeviceInfo.userAgent (512); ids are 64.
 */
const WIRE_MAX_STRING = 512;
const WIRE_MAX_ID = 64;
const WIRE_MAX_ITEMS = 512;
const WIRE_ID_KEYS = new Set(["trackId", "clientId", "referenceClientId"]);
export function wireSafe(value: unknown, key = ""): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= (WIRE_ID_KEYS.has(key) ? WIRE_MAX_ID : WIRE_MAX_STRING);
  if (Array.isArray(value)) return value.length <= WIRE_MAX_ITEMS && value.every((v) => wireSafe(v));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= WIRE_MAX_ITEMS && entries.every(([k, v]) => k.length <= WIRE_MAX_ID && wireSafe(v, k));
  }
  return true;
}

/** A measured output latency or calibration residual beyond this is not a measurement, it is a bug or an attack. */
const LATENCY_SANITY_MAX_MS = 2000;

/**
 * Per-socket message budget. A healthy client peaks around 15 messages a second (the NTP burst, a
 * host dragging a phone on the map at SET_POSITION_MAX_HZ); every message costs a JSON parse, a zod
 * parse and often a replan on the one thread that also timestamps every room's NTP replies.
 */
export const MAX_MESSAGES_PER_SECOND = 100;

/**
 * Per-socket state. `host` is the privilege bit: true only for a socket whose own JOIN presented the
 * room's hostKey. Authority is checked per socket, not per client record — client ids are public
 * (every ROOM_STATE lists them), so "this socket says it is client X" proves nothing (audit SG-02).
 */
export type Conn = { clientId: string | null; roomCode: string | null; host?: boolean; rate?: { windowStart: number; count: number }; /** Caller address, set at upgrade. */ ip?: string; /** Room code this socket's JOIN is waiting on (RoomManager.park). */ parked?: string };
type WS = Bun.ServerWebSocket<Conn>;

interface HealthRecord {
  rttMs: number | null;
  syncErrMs: number | null;
  outputLatencyMs: number | null;
  audioState: AudioState;
  lastSeenServerTime: number;
}

function send(ws: WS, msg: ServerMessage) {
  ws.send(JSON.stringify(msg));
}

/**
 * A state snapshot (ROOM_STATE, HEALTH) is superseded by the next one, so it is never queued behind
 * data a socket has not taken yet: a phone that stopped reading — locked screen, dead spot — would
 * otherwise collect every snapshot the room publishes until it is closed. Measured before this
 * existed: 10 such sockets in a 200-phone room added 142 MB to the server in 69 s (SCALE-NET-03).
 */
const SNAPSHOT_BACKLOG_BYTES = 64 * 1024;
const backlog = (ws: WS): number => (typeof ws.getBufferedAmount === "function" ? ws.getBufferedAmount() : 0);

/** One room: state + sockets + every timer that keeps it alive. */
export class Room {
  code: string;
  hostKey: string;
  room: RoomState;
  /** The socket that speaks for each client id: always the one that JOINed most recently. */
  sockets = new Map<string, WS>();
  /**
   * Older sockets that JOINed under the same client id and are still open. One browser's tabs share
   * `hive:clientId:<room>`, so two live sockets per id is an ordinary state, not only a reconnect
   * race: when the newest closes, the client is still here on the one before it (audit SG-03).
   */
  private standby = new Map<string, WS[]>();
  /** Read-only sockets with no client identity (see observe()). They watch; that includes HEALTH. */
  private observers = new Set<WS>();
  health = new Map<string, HealthRecord>();
  joinCounter = 0;
  dirty = false;

  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private calibrationTimers: ReturnType<typeof setTimeout>[] = [];
  private sceneTimer: ReturnType<typeof setTimeout> | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval>;
  private pingTimer: ReturnType<typeof setInterval>;
  /** Leading-edge ROOM_STATE coalescing: publish immediately if the last publish was >= the rate cap ago;
   *  otherwise arm one trailing timer for the remainder of the window. A burst of changes (e.g. several
   *  JOINs at once) always produces at most one broadcast per window, on the earliest possible edge of it —
   *  never delayed by a full window the way a plain setInterval poll would (docs/PROTOCOL-REQUESTS.md R-1). */
  private lastPublishAt = -Infinity;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last ROOM_STATE each socket was sent, and when: what makes the per-recipient dedupe possible. */
  private lastSent = new WeakMap<WS, { msg: string; at: number }>();

  constructor(
    code: string,
    private server: Bun.Server<Conn>,
    private onEmpty: () => void,
    private getLibrary: () => LibraryEntry[],
    /** The manager passes a signed key (host-key.ts); a bare Room (tests) gets an unguessable random one. */
    hostKey: string = crypto.randomUUID(),
    private libraryScope: LibraryScope = "owner",
  ) {
    this.code = code;
    this.hostKey = hostKey;
    this.room = {
      code,
      protocolVersion: PROTOCOL_VERSION,
      createdAtServerTime: now(),
      hostClientIds: [],
      track: null,
      transport: { state: "stopped" },
      mode: { kind: "UNISON", params: {} },
      scenePlan: null,
      calibration: IDLE_CALIBRATION,
      clients: {},
    };
    this.healthTimer = setInterval(() => this.publishHealth(), 1000 / HEALTH_HZ);
    this.pingTimer = setInterval(() => this.tickPing(), PING_INTERVAL_MS);
    this.idleTimer = setTimeout(() => this.onEmpty(), ROOM_UNCLAIMED_TTL_MS); // cleared by the first JOIN
  }

  // ---- lifecycle -------------------------------------------------------------
  private destroyed = false;
  destroy() {
    this.destroyed = true;
    clearInterval(this.healthTimer);
    clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    for (const t of this.calibrationTimers) clearTimeout(t);
    // A room ends with no client records, but observers are not records: a display left open on a
    // room that idled out would otherwise stay attached to nothing — and now that state is sent
    // per recipient rather than to a topic, it would never hear from a re-created room either.
    // Hung up on, it reconnects and re-JOINs like anyone else.
    for (const ws of this.observers) ws.close(1001, "room ended");
    this.observers.clear();
  }

  private checkIdle() {
    if (Object.keys(this.room.clients).length === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.onEmpty(), ROOM_IDLE_TTL_MS);
    }
  }

  private clearDisconnectTimer(id: string) {
    const t = this.disconnectTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.disconnectTimers.delete(id);
    }
  }

  // ---- core planner / broadcast ------------------------------------------------
  private replan(applyAt: number | null = null) {
    this.room = withAssignments(this.room, applyAt);
    this.dirty = true;
    this.flush();
  }

  /** Leading-edge coalescing (see the field comment above): call after every state change. A small
   *  guard band on the trailing timer keeps consecutive publishes at or past minGapMs even accounting
   *  for ordinary setTimeout scheduling granularity (measured with apps/server/scripts/load-test.ts:
   *  without it, timer jitter alone can shave a few ms off the nominal gap under sustained load). */
  private static readonly TRAILING_GUARD_MS = 20;
  private flush() {
    if (!this.dirty) return;
    const minGapMs = 1000 / ROOM_STATE_MAX_HZ;
    const elapsed = now() - this.lastPublishAt;
    if (elapsed >= minGapMs) {
      this.dirty = false;
      this.lastPublishAt = now();
      if (this.trailingTimer) {
        clearTimeout(this.trailingTimer);
        this.trailingTimer = null;
      }
      // A recipient that could not take this snapshot (backlog) is retried on the next window.
      if (this.sendState()) this.dirty = true;
    }
    if (this.dirty && !this.trailingTimer) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        this.flush();
      }, Math.max(0, minGapMs - (now() - this.lastPublishAt)) + Room.TRAILING_GUARD_MS);
    }
  }

  /**
   * One ROOM_STATE per recipient, built from what that recipient reads (SCALE-NET-02).
   *
   * The whole roster used to go to every socket: ~650 bytes per client, to every client, at up to
   * 2 Hz — quadratic in the size of the party (8.7 MB/s at 100 phones with a busy host, 35 MB/s at
   * 200, and past the 64 KB message budget near 74 phones). But a phone only ever reads the
   * room-level state and its own record; the planner runs here and stamps each record with its
   * finished assignment. So:
   *
   *  - a **player** gets the room-level state and a roster of exactly one: itself. `hostClientIds`
   *    is empty for it and the calibration block is cut to what its tuning screen shows (how many
   *    clicks, which one is its own, its own result) — other clients' ids are not sent to players;
   *  - **hosts, viewers and observers** get the full snapshot: the map, the roster and the health
   *    view are made of it.
   *
   * Both are valid ROOM_STATEs under the unchanged schema. A recipient whose message would be
   * byte-identical to the last one it was sent is skipped (a dot dragged on the host's map changes
   * one record, not a hundred phones' worth of state), unless `refreshOlderThanMs` says its copy is
   * old enough to repeat anyway (the heartbeat).
   *
   * Returns true if some recipient was skipped because it has not drained what it was sent before.
   */
  private sendState(refreshOlderThanMs = Infinity): boolean {
    const t = now();
    const { clients, calibration, hostClientIds: _hosts, ...level } = this.room;
    let full: string | null = null;
    const fullView = () => (full ??= JSON.stringify({ type: "ROOM_STATE", room: this.room } satisfies ServerMessage));

    // `{"code":…,"transport":…` — everything every player gets, serialised once, left open.
    const shared = JSON.stringify({ ...level, hostClientIds: [] }).slice(0, -1);
    const inFlight = calibration.state === "countdown" || calibration.state === "running";
    const quiet = { state: calibration.state, referenceClientId: null, startServerTime: calibration.startServerTime, order: [] as string[], results: {} };
    const quietJson = JSON.stringify(quiet);
    const playerView = (id: string, rec: ClientRecord): string => {
      const mine = calibration.results[id];
      const isReference = calibration.referenceClientId === id;
      const cal =
        inFlight || mine || isReference
          ? JSON.stringify({
              ...quiet,
              referenceClientId: isReference ? id : null,
              // The slots, with every id but its own blanked: enough for "click 7 of 30, yours is the 12th".
              order: inFlight ? calibration.order.map((o) => (o === id ? o : "")) : [],
              results: mine ? { [id]: mine } : {},
            })
          : quietJson;
      return `{"type":"ROOM_STATE","room":${shared},"calibration":${cal},"clients":{${JSON.stringify(id)}:${JSON.stringify(rec)}}}}`;
    };

    let skipped = false;
    const deliver = (ws: WS, view: () => string) => {
      const last = this.lastSent.get(ws);
      if (backlog(ws) > SNAPSHOT_BACKLOG_BYTES) {
        // Whatever it holds is stale by now; make sure it gets the current state once it drains.
        if (last) this.lastSent.delete(ws);
        skipped = true;
        return;
      }
      const msg = view();
      if (last && last.msg === msg && t - last.at < refreshOlderThanMs) return;
      ws.send(msg);
      this.lastSent.set(ws, { msg, at: t });
    };
    const viewFor = (id: string): (() => string) | null => {
      const rec = clients[id];
      if (!rec) return null;
      return rec.kind === "player" ? () => playerView(id, rec) : fullView;
    };
    for (const [id, ws] of this.sockets) {
      const view = viewFor(id);
      if (view) deliver(ws, view);
    }
    for (const [id, older] of this.standby) {
      const view = viewFor(id);
      if (view) for (const ws of older) deliver(ws, view);
    }
    for (const ws of this.observers) deliver(ws, fullView);
    return skipped;
  }

  private publishHealth() {
    const t = now();
    const clients: Record<string, HealthRecord> = {};
    for (const [id, h] of this.health) if (this.room.clients[id]) clients[id] = h;
    // Hosts and viewers (docs/02-protocol.md: "HEALTH 1 Hz to hosts and viewers"): a /screen
    // display's "Synced ±N ms" tile is a median over exactly these numbers, and it is the one thing a
    // viewer cannot derive from ROOM_STATE. The mock already did this; the real server sent hosts only.
    for (const c of Object.values(this.room.clients)) {
      if (c.kind !== "host" && c.kind !== "viewer") continue;
      const s = this.sockets.get(c.id);
      if (s && backlog(s) <= SNAPSHOT_BACKLOG_BYTES) send(s, { type: "HEALTH", serverTime: t, clients });
    }
    // Observers too: HEALTH needs no credential (any viewer gets it), and the usual observer is the
    // host's own /screen tab, whose sync tile is made of these numbers.
    for (const s of this.observers) if (backlog(s) <= SNAPSHOT_BACKLOG_BYTES) send(s, { type: "HEALTH", serverTime: t, clients });
  }

  private tickPing() {
    const t = now();
    for (const [id, s] of this.sockets) {
      const h = this.health.get(id);
      if (h && t - h.lastSeenServerTime > 2 * PING_INTERVAL_MS + 5000) s.close(1001, "ping timeout");
    }
    this.server.publish(this.code, JSON.stringify({ type: "PING", serverTime: t } satisfies ServerMessage));
  }

  /**
   * Whose uploads this room may use: the id of its host's browser (a hash of the libraryKey its
   * JOIN carried), or null — shared tracks only. Not part of RoomState, never broadcast.
   */
  libraryOwner: string | null = null;

  /** The tracks this room can list, select and rotate through: shared ones plus its host's own. */
  library(): LibraryEntry[] {
    return visibleLibrary(this.getLibrary(), this.libraryOwner, this.libraryScope);
  }

  private static trackInfo(t: LibraryEntry): TrackInfo {
    return { id: t.id, title: t.title, durationSec: t.durationSec, stems: t.stems, bpm: t.bpm, beatOffsetSec: t.beatOffsetSec };
  }

  private setTrack(t: LibraryEntry) {
    this.room.track = Room.trackInfo(t);
    this.refreshNextTrack();
  }

  /**
   * `room.nextTrack`: the song the rotation would advance to when the current one ends (null for a
   * single-song loop or no track). Phones start downloading it during the current song — the
   * advance itself only gives TRACK_ADVANCE_LEAD_MS. A hint, recomputed whenever its inputs move:
   * the track (setTrack) and the library (onLibraryChanged). Returns whether it changed.
   */
  private refreshNextTrack(): boolean {
    const next = this.room.track ? nextInRotation(this.library(), this.room.track.id) : null;
    const info = next ? Room.trackInfo(next) : null;
    if (JSON.stringify(info) === JSON.stringify(this.room.nextTrack ?? null)) return false; // absent and null mean the same
    this.room.nextTrack = info;
    return true;
  }

  /** An upload (or the tempo backfill) changed the library: the rotation may now lead somewhere else. */
  onLibraryChanged() {
    if (this.destroyed || !this.refreshNextTrack()) return;
    this.dirty = true;
    this.flush();
  }

  // ---- scene timer (B5s) -------------------------------------------------------
  private cancelSceneTimer() {
    if (this.sceneTimer) {
      clearTimeout(this.sceneTimer);
      this.sceneTimer = null;
    }
  }

  private rearmSceneTimer() {
    this.cancelSceneTimer();
    if (!this.room.scenePlan) return;
    const armed = nextScene(this.room.scenePlan, this.room.transport, now());
    if (!armed) return;
    const delay = Math.max(0, armed.fireAtServerTime - now());
    this.sceneTimer = setTimeout(() => this.fireScene(armed.scene.mode, armed.scene.params, armed.boundaryServerTime), delay);
  }

  private fireScene(mode: RoomState["mode"]["kind"], params: RoomState["mode"]["params"], boundaryServerTime: number) {
    this.room.mode = { kind: mode, params };
    this.replan(boundaryServerTime); // flushes internally
    this.rearmSceneTimer();
  }

  /** PLAY/SEEK: the latest scene at or before the new position becomes the current mode immediately. */
  private syncModeToScenePlan() {
    if (!this.room.scenePlan || this.room.transport.state !== "playing") return;
    const cur = currentScene(this.room.scenePlan, this.room.transport, now());
    if (cur) {
      this.room.mode = { kind: cur.mode, params: cur.params };
      this.replan(null);
    }
  }

  // ---- loop timer ----------------------------------------------------------------
  /**
   * Nothing used to fire at the end of the track: the room stayed "playing" forever with every
   * phone silent. The loop timer fires LEAD_MS before the boundary and keeps the party going:
   * with more than one real song in the library it advances to the next one (playlist rotation,
   * wrapping); with a single song it restarts that song seamlessly — serverTimeAtTrackZero moves
   * to exactly the old end, so phones schedule the restart on the boundary instant itself.
   */
  private cancelLoopTimer() {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  private rearmLoopTimer() {
    this.cancelLoopTimer();
    if (this.room.transport.state !== "playing" || !this.room.track) return;
    const endServerTime = this.room.transport.serverTimeAtTrackZero + this.room.track.durationSec * 1000;
    const delay = Math.max(0, endServerTime - LEAD_MS - now());
    this.loopTimer = setTimeout(() => this.loopBack(endServerTime), delay);
  }

  private loopBack(endServerTime: number) {
    this.loopTimer = null;
    if (this.room.transport.state !== "playing" || !this.room.track) return;
    // Playlist rotation (nextInRotation, shared with the mock): real songs only, so a party never
    // lands on a synthetic test track unless the library holds nothing else. The library is read
    // live — a song uploaded mid-show joins the rotation before the current one ends.
    const next = nextInRotation(this.library(), this.room.track.id);

    if (next) {
      // Advance to the next song. Phones have not downloaded it yet, so the start gets a breather
      // (TRACK_ADVANCE_LEAD_MS) — fast phones start together on that instant, slow ones drop in
      // mid-song the moment their stems decode, exactly like a late joiner.
      this.setTrack(next);
      this.room.scenePlan = null; // the vibe plan was authored for the song that just ended
      this.modeVersion++; // and one still in flight for it must not land on the next song
      this.room.transport = { state: "playing", serverTimeAtTrackZero: Math.max(now(), endServerTime) + TRACK_ADVANCE_LEAD_MS };
      this.replan(); // stem choices depend on the track; assignment + snapshot go out together
    } else {
      // Single song: restart it seamlessly when the boundary is still comfortably ahead (this
      // fires LEAD_MS early); a boundary too close or already past (a SEEK beyond the end, or a
      // room found stuck from before this timer existed) restarts with the standard lead instead —
      // a serverTimeAtTrackZero in the past would start mid-track.
      this.room.transport = { state: "playing", serverTimeAtTrackZero: loopRestartZero(endServerTime, now()) };
      this.dirty = true;
      this.flush();
    }
    this.syncModeToScenePlan();
    this.rearmSceneTimer();
    this.rearmLoopTimer();
  }

  /**
   * Bumped on every manual SET_MODE. The vibe route snapshots this before the (up to 5s) LLM call and
   * passes it back to acceptScenePlan; if a host tapped a mode chip while that request was in flight,
   * the version has moved and the now-stale plan is dropped instead of clobbering their manual choice.
   */
  private modeVersion = 0;
  getModeVersion(): number {
    return this.modeVersion;
  }

  /** Called by the vibe route (B6) once a plan is accepted. Returns false if it was dropped as stale. */
  acceptScenePlan(plan: ScenePlan, requestModeVersion?: number): boolean {
    if (requestModeVersion !== undefined && requestModeVersion !== this.modeVersion) return false;
    // The vibe route awaits an LLM call for up to 5 s; the room can idle out underneath it, and a
    // scene timer armed on a destroyed room is a timer nothing will ever clear.
    if (this.destroyed) return false;
    this.room.scenePlan = plan;
    if (this.room.transport.state === "playing") this.syncModeToScenePlan();
    else this.dirty = true;
    this.rearmSceneTimer();
    this.flush();
    return true;
  }

  // ---- calibration (B8s, CALIBRATION_CANCEL) ------------------------------------
  private clearCalibrationTimers() {
    for (const t of this.calibrationTimers) clearTimeout(t);
    this.calibrationTimers = [];
  }

  /**
   * CALIBRATION_CANCEL: back to idle at once. The SCHEDULED_ACTIONs already sent to players are on
   * the wire — the server cannot un-send them — so each client drops its own pending clicks once it
   * sees `idle` (docs/04). Flushed directly rather than left to the coalescer: every millisecond of
   * delay is another click the room hears after someone pressed Cancel.
   */
  private cancelCalibration() {
    this.clearCalibrationTimers();
    this.room.calibration = IDLE_CALIBRATION;
    this.dirty = true;
    this.flush();
  }

  /**
   * CALIBRATION_RESET (v3): throw away measured offsets, for one client or the whole room.
   * Cleared to `null`, never `0` — null falls back through `tableLatencyMs` and then the phone's own
   * `ctx.outputLatency`; zero is a positive claim that the phone has no output latency, which is never
   * true. Refused while a run is in flight (state !== "idle"): a residual is measured against whatever
   * compensation the phone was applying when its click sounded, so clearing the base between the click
   * and the report would add that residual to a *different* base — baking in exactly the error the
   * reset was meant to undo. Cancel first, then reset.
   */
  private resetCalibration(ws: WS, clientId?: string) {
    if (this.room.calibration.state !== "idle") {
      return send(ws, { type: "ERROR", code: "CALIBRATION_BUSY", message: `cannot reset while calibration is ${this.room.calibration.state}: cancel first` });
    }
    if (clientId && !this.room.clients[clientId]) {
      return send(ws, { type: "ERROR", code: "NO_CLIENT", message: `no client ${clientId}` });
    }
    const targets = clientId ? [this.room.clients[clientId]!] : Object.values(this.room.clients);
    for (const c of targets) c.calibratedOffsetMs = null;
    this.replan(); // compensationMs is derived from what was just cleared; replan() flushes directly
  }

  private startCalibration(referenceClientId: string) {
    this.clearCalibrationTimers();

    // Only a speaker that is actually connected and has this track's stems decoded can produce a
    // click worth measuring; a disconnected-but-retained record or one still loading gets a silent
    // slot in the schedule otherwise (dead air, and a click that never arrives for the reference to see).
    const order = Object.values(this.room.clients)
      .filter((c) => c.plays && c.id !== referenceClientId && c.connected && c.audioReadyTrackId === this.room.track?.id)
      .sort((a, b) => a.joinIndex - b.joinIndex)
      .map((c) => c.id);
    const start = now() + CALIBRATION_COUNTDOWN_MS;
    this.room.calibration = { state: "countdown", referenceClientId, startServerTime: start, order, results: {} };
    this.dirty = true;
    this.flush();

    const ref = this.sockets.get(referenceClientId);
    if (ref) send(ref, { type: "CALIBRATION_PLAN", startServerTime: start, intervalMs: CALIBRATION_CLICK_INTERVAL_MS, order, clickSpec: DEFAULT_CLICK_SPEC });
    order.forEach((id, i) => {
      const at = start + i * CALIBRATION_CLICK_INTERVAL_MS;
      const s = this.sockets.get(id);
      if (s) send(s, { type: "SCHEDULED_ACTION", serverTimeToExecute: at, action: { kind: "CALIBRATION_CLICK", clickId: `${id}:${i}`, clickSpec: DEFAULT_CLICK_SPEC } });
    });

    this.calibrationTimers.push(
      setTimeout(() => {
        if (this.room.calibration.state === "countdown") {
          this.room.calibration = { ...this.room.calibration, state: "running" };
          this.dirty = true;
          this.flush();
        }
      }, CALIBRATION_COUNTDOWN_MS),
      setTimeout(
        () => {
          if (this.room.calibration.state !== "done") {
            this.room.calibration = { ...this.room.calibration, state: "failed" };
            this.dirty = true;
            this.flush();
          }
        },
        CALIBRATION_COUNTDOWN_MS + order.length * CALIBRATION_CLICK_INTERVAL_MS + 5000,
      ),
    );
  }

  private handleCalibrationReport(me: ClientRecord | undefined, msg: Extract<ClientMessage, { type: "CALIBRATION_REPORT" }>) {
    if (!me || me.id !== this.room.calibration.referenceClientId) return;
    // Only while a run is in flight. `done` used to be accepted too, so a second report for the same
    // run was added on top of the first: calibratedOffsetMs = base + residual + residual.
    if (this.room.calibration.state !== "countdown" && this.room.calibration.state !== "running") return;
    for (const m of msg.measurements) {
      const c = this.room.clients[m.clientId];
      if (!c || m.confidence < 0.5) continue; // low-confidence peaks are ignored
      if (Math.abs(m.residualMs) > LATENCY_SANITY_MAX_MS) continue; // not a click heard in a room
      // Before any calibration, a client with no table entry (STARTER_LATENCY_TABLE_MS.other is null)
      // silently subtracts its own ctx.outputLatency locally (docs/02-protocol.md §1: "no table AND no
      // calibration"). Once calibratedOffsetMs is non-null the client stops doing that — so basing the
      // first round on tableLatencyMs ?? 0 alone would drop that compensation entirely and leave the
      // phone late by exactly its outputLatency. Falling back to the client's own reported
      // outputLatencyMs (CLIENT_STATUS) instead of 0 preserves it across the transition.
      const base = c.calibratedOffsetMs ?? c.tableLatencyMs ?? this.health.get(m.clientId)?.outputLatencyMs ?? 0;
      c.calibratedOffsetMs = base + m.residualMs;
      this.room.calibration.results[m.clientId] = { residualMs: m.residualMs, confidence: m.confidence };
    }
    this.room.calibration = { ...this.room.calibration, state: "done" };
    this.replan();
  }

  // ---- join / disconnect --------------------------------------------------------
  join(ws: WS, msg: Extract<ClientMessage, { type: "JOIN" }>) {
    const existing = this.room.clients[msg.clientId];
    // Host is granted by exactly one thing: this JOIN carries the room's hostKey. It used to be
    // granted as well when the record was already a host, or when the room had no host yet — but
    // every client id is in every ROOM_STATE, and "no host yet" is true between POST /rooms and the
    // host's first JOIN and again 2 minutes after the host's phone locks. Either let any guest
    // become host with no key (audit SG-02). A host that lost its room to a restart does not need
    // those clauses any more: its signed key re-creates the room (RoomManager, audit SG-01).
    const wantsHost = msg.kind === "host" && typeof msg.hostKey === "string" && safeEqual(msg.hostKey, this.hostKey);
    if (existing?.kind === "host" && !wantsHost) return this.observe(ws, msg.clientId);
    // The key holder is exempt: a host must always be able to get in and KICK.
    if (!existing && !wantsHost && Object.keys(this.room.clients).length >= MAX_ROOM_CLIENTS) {
      return send(ws, { type: "ERROR", code: "ROOM_FULL", message: `this hive is full (${MAX_ROOM_CLIENTS} devices)` });
    }
    // userAgent (up to 512 chars, required by DeviceInfoSchema) is dead weight on every ROOM_STATE
    // broadcast — nothing server-side reads it, only browserFamily/platform/model do — and it's most
    // of a snapshot's size at scale (~26-30KB at 30 phones). Never store the real string.
    const device = { ...msg.device, userAgent: "" };
    // A viewer (v4, the /screen projector) is read-only: plays is forced false whatever the JOIN
    // says, it never lands in hostClientIds, and it must not be coerced to "player" — that made
    // every projector a phantom speaker that stole a stem in ORCHESTRA and padded the player count.
    const isViewer = !wantsHost && msg.kind === "viewer";
    const rec: ClientRecord = existing
      ? {
          ...existing,
          connected: true,
          name: msg.name ?? existing.name,
          device,
          // A viewer record that re-JOINs as a player becomes one (parity probe S2). One browser
          // shares its client id between /screen and /j, so "look at the display, then join as a
          // phone" arrives exactly like that, and keeping `viewer, plays:false` left the phone
          // silent for the rest of the night. The reverse is deliberately NOT followed (the mock
          // does): a player record that re-JOINs as a viewer stays a player — the phone tab is
          // still open and playing, and anyone who can read the roster could otherwise silence any
          // phone by joining as a display under its id. (A host record never gets here without the
          // key — see observe() — so a JOIN can never demote a host either.)
          kind: wantsHost ? "host" : existing.kind === "viewer" && !isViewer ? "player" : existing.kind,
          plays: wantsHost ? msg.plays : existing.kind === "viewer" ? !isViewer : existing.plays,
        }
      : {
          id: msg.clientId,
          kind: wantsHost ? "host" : isViewer ? "viewer" : "player",
          plays: wantsHost ? msg.plays : !isViewer,
          name: msg.name ?? `Phone ${this.joinCounter + 1}`,
          device,
          joinIndex: this.joinCounter++,
          joinedAtServerTime: now(),
          position: null,
          pinnedRole: null,
          nudgeMs: 0,
          tableLatencyMs: STARTER_LATENCY_TABLE_MS[msg.device.browserFamily],
          calibratedOffsetMs: null,
          assignment: null,
          connected: true,
          audioReadyTrackId: null,
        };
    this.room.clients[rec.id] = rec;
    if (rec.kind === "host" && !this.room.hostClientIds.includes(rec.id)) this.room.hostClientIds.push(rec.id);
    // Unreachable today (a host record is only re-joined with the key, as a host), kept so that
    // "in hostClientIds" can never outlive "is a host record" whatever the rules above become.
    if (rec.kind !== "host") this.room.hostClientIds = this.room.hostClientIds.filter((id) => id !== rec.id);

    ws.data.clientId = rec.id;
    ws.data.roomCode = this.code;
    ws.data.host = wantsHost;
    // Only a JOIN that proved it is the host says whose library this room uses; the last one wins.
    // A host JOIN without a libraryKey (an older client) leaves things as they are.
    if (wantsHost && msg.libraryKey) {
      const owner = ownerIdOf(msg.libraryKey);
      if (owner !== this.libraryOwner) {
        this.libraryOwner = owner;
        this.refreshNextTrack(); // the rotation may lead somewhere else now; the replan below publishes it
      }
    }
    const previous = this.sockets.get(rec.id);
    if (previous && previous !== ws) {
      const older = this.standby.get(rec.id) ?? [];
      older.push(previous);
      this.standby.set(rec.id, older);
    }
    this.sockets.set(rec.id, ws);
    ws.subscribe(this.code);
    this.clearDisconnectTimer(rec.id);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.health.set(rec.id, { rttMs: null, syncErrMs: null, outputLatencyMs: null, audioState: "locked", lastSeenServerTime: now() });

    send(ws, { type: "WELCOME", clientId: rec.id, roomCode: this.code, serverTime: now(), protocolVersion: PROTOCOL_VERSION, isHost: rec.kind === "host" });
    // ROOM_STATE is a room-wide broadcast, so the joiner's own subscribe() above means replan()'s flush
    // (leading-edge: immediate in a quiet room, coalesced into the next window during a join burst) is
    // also "the joiner's snapshot" — a burst of joins must still respect ROOM_STATE_MAX_HZ.
    this.replan();
  }

  /**
   * A JOIN that names the host's client id but does not carry the hostKey. Honest cause: one browser
   * shares `hive:clientId:<room>` between /h, /j and /screen, so a second tab arrives under the
   * host's id. Hostile cause: a guest read the id out of ROOM_STATE. Either way the socket may watch
   * the room and nothing else: it is not registered as the host's socket (so it cannot take the
   * host's HEALTH / calibration messages, and its close cannot mark the host disconnected), it has
   * no client identity (`clientId` stays null, so every command is a no-op or NOT_HOST), and the
   * host's record is left exactly as it was.
   */
  private observe(ws: WS, claimedId: string) {
    // Observers are not client records, so MAX_ROOM_CLIENTS does not see them; a handful covers the
    // honest case (a host's extra tabs) and keeps this from being an uncapped way into the fan-out.
    if (this.observers.size >= MAX_ROOM_OBSERVERS) return send(ws, { type: "ERROR", code: "ROOM_FULL", message: "too many displays on this hive" });
    ws.data.clientId = null;
    ws.data.roomCode = this.code;
    ws.data.host = false;
    ws.subscribe(this.code);
    this.observers.add(ws);
    send(ws, { type: "WELCOME", clientId: claimedId, roomCode: this.code, serverTime: now(), protocolVersion: PROTOCOL_VERSION, isHost: false });
    const snapshot = JSON.stringify({ type: "ROOM_STATE", room: this.room } satisfies ServerMessage);
    ws.send(snapshot);
    this.lastSent.set(ws, { msg: snapshot, at: now() });
  }

  disconnect(ws: WS) {
    this.observers.delete(ws);
    const id = ws.data.clientId;
    if (!id) return;
    // A duplicate/stale socket for the same clientId (e.g. a reconnect that raced the old socket's
    // close) must not tear down the live one — join() always makes the newest socket the one
    // registered in `this.sockets`, so if this isn't it, the client is still connected elsewhere.
    const older = this.standby.get(id);
    if (this.sockets.get(id) !== ws) {
      if (older) {
        const rest = older.filter((s) => s !== ws);
        if (rest.length > 0) this.standby.set(id, rest);
        else this.standby.delete(id);
      }
      return;
    }
    // And the mirror image: the NEWEST socket closing while an older one is still open (the second
    // tab was closed, the first is still playing). The client has not left — hand its seat back to
    // the older socket instead of marking it disconnected and deleting its record 2 minutes later.
    const heir = older?.pop();
    if (heir) {
      if (older!.length === 0) this.standby.delete(id);
      this.sockets.set(id, heir);
      return;
    }
    this.sockets.delete(id); // before the broadcast below: a closed socket is not a recipient
    const c = this.room.clients[id];
    if (c) {
      c.connected = false;
      // `connected` is a planner input (PROTO-05): a phone that drops takes its stem with it unless
      // the plan is redone — its ORCHESTRA stem is folded onto the phones still here, STROBE groups
      // are re-dealt over them. Marking the snapshot dirty alone left that part of the song silent
      // until something else happened to trigger a re-plan.
      this.replan();
    }
    this.clearDisconnectTimer(id);
    const timer = setTimeout(() => {
      delete this.room.clients[id];
      this.health.delete(id); // or the map grows by one entry per device that ever joined
      this.room.hostClientIds = this.room.hostClientIds.filter((hid) => hid !== id);
      this.disconnectTimers.delete(id);
      this.replan(); // the roster changed: layouts and group deals are computed over it
      this.checkIdle();
    }, DISCONNECT_RETENTION_MS);
    this.disconnectTimers.set(id, timer);
  }

  // ---- message dispatch ---------------------------------------------------------
  handle(ws: WS, msg: ClientMessage) {
    const me = ws.data.clientId ? this.room.clients[ws.data.clientId] : undefined;
    const isHost = !!me && ws.data.host === true && this.room.hostClientIds.includes(me.id);
    const hostOnly = (): boolean => {
      if (!isHost) {
        send(ws, { type: "ERROR", code: "NOT_HOST", message: "host only" });
        return false;
      }
      return true;
    };

    switch (msg.type) {
      case "JOIN":
        return; // handled by RoomManager before dispatch
      case "NTP_REQUEST": {
        const t1 = now();
        return send(ws, { type: "NTP_RESPONSE", t0: msg.t0, t1, t2: now(), probeGroupId: msg.probeGroupId, probeGroupIndex: msg.probeGroupIndex });
      }
      case "PONG":
        if (me) {
          const h = this.health.get(me.id);
          if (h) h.lastSeenServerTime = now();
        }
        return;
      case "CLIENT_STATUS":
        if (me) {
          // outputLatencyMs is the accumulation base of this client's first calibration (see
          // handleCalibrationReport), so a nonsense value here becomes a nonsense offset there.
          const outputLatencyMs = msg.outputLatencyMs != null && msg.outputLatencyMs >= 0 && msg.outputLatencyMs <= LATENCY_SANITY_MAX_MS ? msg.outputLatencyMs : null;
          this.health.set(me.id, { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs, audioState: msg.audioState, lastSeenServerTime: now() });
          // A phone that reports a live ctx.outputLatency knows its own output path better than the
          // starter table's per-family guess. Nulling tableLatencyMs makes the client subtract that
          // live value itself (useOutputLatency: "no table AND no calibration"), and the replan drops
          // the guess from compensationMs in the same ROOM_STATE snapshot — so the two sides can never
          // double-count. One-way and self-extinguishing: table never comes back, and a later
          // calibration still accumulates onto health.outputLatencyMs (the report handler's base).
          if (me.calibratedOffsetMs == null && me.tableLatencyMs != null && outputLatencyMs != null && outputLatencyMs > 0) {
            me.tableLatencyMs = null;
            this.replan();
          }
        }
        return;
      case "AUDIO_READY":
        if (me) {
          me.audioReadyTrackId = msg.trackId;
          this.dirty = true;
          this.flush();
        }
        return;
      case "SET_PLAYS":
        if (me && isHost) {
          me.plays = msg.plays;
          this.replan();
        }
        return;
      case "SET_TRACK": {
        if (!hostOnly()) return;
        // (another owner's upload is not in library(): it answers NO_TRACK exactly like an id that does not exist)
        const track = this.library().find((t) => t.id === msg.trackId);
        if (!track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: `unknown track ${msg.trackId}` });
        // A vibe plan is scene boundaries in ONE song's track time. The playlist advance already
        // drops it (loopBack); switching songs by hand kept it, and the next PLAY drove the new
        // song's modes off the old song's timeline.
        if (this.room.track?.id !== track.id) {
          this.room.scenePlan = null;
          this.modeVersion++; // …and a plan still being written for the old song must not land on this one
        }
        this.setTrack(track);
        this.room.transport = { state: "stopped" };
        this.cancelSceneTimer();
        this.cancelLoopTimer();
        this.replan();
        return;
      }
      case "TRANSPORT": {
        if (!hostOnly()) return;
        if (!this.room.track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: "SET_TRACK first" });
        const t = now();
        if (msg.action === "PLAY" || msg.action === "SEEK") {
          const from = msg.trackTimeSec ?? (this.room.transport.state === "paused" ? this.room.transport.trackTimeAtPause : 0);
          this.room.transport = { state: "playing", serverTimeAtTrackZero: t + LEAD_MS - from * 1000 };
          this.dirty = true;
          this.flush();
          this.syncModeToScenePlan();
          this.rearmSceneTimer();
          this.rearmLoopTimer();
        } else if (msg.action === "PAUSE" && this.room.transport.state === "playing") {
          this.room.transport = { state: "paused", trackTimeAtPause: trackTimeSec(this.room.transport, t) };
          this.dirty = true;
          this.flush();
          this.cancelSceneTimer();
          this.cancelLoopTimer();
        }
        return;
      }
      case "SET_MODE":
        if (!hostOnly()) return;
        this.room.mode = { kind: msg.mode, params: msg.params };
        this.room.scenePlan = null; // manual override wins
        this.modeVersion++; // invalidates any vibe request already in flight
        this.cancelSceneTimer();
        this.replan();
        return;
      case "ASSIGN":
        if (!hostOnly()) return;
        if (this.room.clients[msg.clientId]) {
          this.room.clients[msg.clientId]!.pinnedRole = msg.role;
          this.replan();
        }
        return;
      case "SET_POSITION":
        if (!hostOnly()) return;
        if (this.room.clients[msg.clientId]) {
          this.room.clients[msg.clientId]!.position = { x: msg.x, y: msg.y };
          this.replan();
        }
        return;
      case "NUDGE":
        if (!(isHost || (me && me.id === msg.clientId))) return;
        if (this.room.clients[msg.clientId]) {
          this.room.clients[msg.clientId]!.nudgeMs = msg.nudgeMs;
          this.replan();
        }
        return;
      case "KICK":
        if (!hostOnly()) return;
        if (this.room.clients[msg.clientId]) {
          // Every socket of that client, not only the newest: a standby one would otherwise sit in
          // the room as a zombie that no longer has a record.
          for (const s of [this.sockets.get(msg.clientId), ...(this.standby.get(msg.clientId) ?? [])]) {
            if (!s) continue;
            send(s, { type: "ERROR", code: "KICKED", message: "removed by host" });
            s.data.clientId = null; // its close event must not be mistaken for anyone's disconnect
            s.close();
          }
          this.sockets.delete(msg.clientId);
          this.standby.delete(msg.clientId);
          this.clearDisconnectTimer(msg.clientId);
          this.health.delete(msg.clientId);
          delete this.room.clients[msg.clientId];
          this.room.hostClientIds = this.room.hostClientIds.filter((id) => id !== msg.clientId);
          this.replan();
          this.checkIdle();
        }
        return;
      case "CALIBRATION_START":
        if (!hostOnly()) return;
        // A reference that is not here cannot hear anything: every phone would click into dead air
        // for the whole run before it timed out as "failed".
        if (!this.room.clients[msg.referenceClientId]?.connected) return send(ws, { type: "ERROR", code: "NO_CLIENT", message: `no connected client ${msg.referenceClientId}` });
        return this.startCalibration(msg.referenceClientId);
      case "CALIBRATION_CANCEL":
        if (!hostOnly()) return;
        return this.cancelCalibration();
      case "CALIBRATION_RESET":
        if (!hostOnly()) return;
        return this.resetCalibration(ws, msg.clientId);
      case "CALIBRATION_REPORT":
        return this.handleCalibrationReport(me, msg);
    }
  }
}

/** Owns every room in the process; one Fly machine only (rooms live in memory). */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private server: Bun.Server<Conn> | null = null;
  private library: LibraryEntry[] = [];

  private keys: HostKeys;
  /**
   * JOINs for codes that do not exist, per caller address. NO_ROOM-vs-WELCOME is the same oracle as
   * GET /rooms/:code, and a socket can ask a hundred times a second: without a budget the 923 521
   * codes can be swept for every live party in minutes (audit SG-14). A phone only ever mistypes a
   * code a few times; a whole party reconnecting to a restarted server is one miss per phone.
   */
  private missedJoins = new RateLimiter(60, 60_000);
  private bootAt = performance.now();
  private parked = new Map<string, Array<{ ws: WS; msg: Extract<ClientMessage, { type: "JOIN" }>; timer: ReturnType<typeof setTimeout> }>>();
  private parkedTotal = 0;

  get parkedCount(): number {
    return this.parkedTotal;
  }

  /** Holds a JOIN for a room that does not exist (yet). See RESTART_GRACE_MS. */
  private park(ws: WS, msg: Extract<ClientMessage, { type: "JOIN" }>, code: string) {
    const timer = setTimeout(() => {
      this.unpark(ws);
      this.missedJoins.allow(ws.data.ip ?? "local");
      send(ws, { type: "ERROR", code: "NO_ROOM", message: `room ${msg.roomCode} does not exist` });
    }, JOIN_PARK_MS);
    const list = this.parked.get(code) ?? [];
    list.push({ ws, msg, timer });
    this.parked.set(code, list);
    this.parkedTotal++;
    ws.data.parked = code;
  }

  private unpark(ws: WS) {
    const code = ws.data.parked;
    if (!code) return;
    ws.data.parked = undefined;
    const rest = (this.parked.get(code) ?? []).filter((e) => {
      if (e.ws !== ws) return true;
      clearTimeout(e.timer);
      this.parkedTotal--;
      return false;
    });
    if (rest.length > 0) this.parked.set(code, rest);
    else this.parked.delete(code);
  }

  /** The room is back: let in everyone who was waiting for it, in the order they arrived. */
  private admitParked(room: Room) {
    const list = this.parked.get(room.code);
    if (!list) return;
    this.parked.delete(room.code);
    for (const e of list) {
      clearTimeout(e.timer);
      this.parkedTotal--;
      e.ws.data.parked = undefined;
      room.join(e.ws, e.msg);
    }
  }

  /**
   * `hostKeySecret` signs every hostKey (host-key.ts). Give it a value that survives restarts and a
   * host can bring their room back under the same code after a deploy; leave it out and keys are
   * only good for the life of this process.
   */
  constructor(private opts: { fixturesDir: string; fixedCode?: string; hostKeySecret?: string; libraryScope?: LibraryScope }) {
    this.keys = new HostKeys(opts.hostKeySecret);
  }

  attachServer(server: Bun.Server<Conn>) {
    this.server = server;
  }

  async loadLibrary() {
    this.library = await loadLibrary(this.opts.fixturesDir);
    for (const room of this.rooms.values()) room.onLibraryChanged();
  }

  getLibrary(): LibraryEntry[] {
    return this.library;
  }

  /** Re-scans fixtures/tracks (called after an upload writes a new track directory). */
  async reloadLibrary() {
    await this.loadLibrary();
  }

  /** True if `key` is the current hostKey of any room in this process (POST /tracks has no room in its path). */
  isKnownHostKey(key: string): boolean {
    return this.roomForHostKey(key) !== undefined;
  }

  /** The live room whose hostKey this is: how the REST routes that carry no room code find their room. */
  roomForHostKey(key: string | undefined | null): Room | undefined {
    if (!key) return undefined;
    for (const room of this.rooms.values()) if (room.hostKey === key) return room;
    return undefined;
  }

  get libraryScope(): LibraryScope {
    return this.opts.libraryScope ?? "owner";
  }

  /** Codes are not returned: only whether some live room has this track selected right now. */
  isTrackInUse(trackId: string): boolean {
    for (const room of this.rooms.values()) if (room.room.track?.id === trackId) return true;
    return false;
  }

  get fixturesDir(): string {
    return this.opts.fixturesDir;
  }

  private randomCode(): string {
    let code: string;
    do {
      code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  /** `hostKey` is only ever a key `this.keys.verify()` accepted for this code (a restore); otherwise a fresh one is issued. */
  private isFull(): boolean {
    return this.rooms.size >= MAX_ROOMS;
  }

  private spawn(code: string, hostKey?: string): Room {
    if (!this.server) throw new Error("RoomManager.attachServer must be called before spawning rooms");
    const room: Room = new Room(
      code,
      this.server,
      () => {
        room.destroy();
        this.rooms.delete(code);
      },
      () => this.library,
      hostKey ?? this.keys.issue(code, now()),
      this.libraryScope,
    );
    this.rooms.set(code, room);
    return room;
  }

  /** A room code this server could have dealt: exactly ROOM_CODE_LENGTH characters of ROOM_CODE_ALPHABET. */
  private isDealtCode(code: string): boolean {
    return code.length === ROOM_CODE_LENGTH && [...code].every((ch) => ROOM_CODE_ALPHABET.includes(ch));
  }

  /** True when `hostKey` is a key this server issued for `code` and may still re-create that room. */
  private canRestore(code: string, hostKey: string | undefined): hostKey is string {
    return !!hostKey && (this.isDealtCode(code) || code === this.opts.fixedCode) && this.keys.verify(code, hostKey, now());
  }

  /**
   * POST /rooms {code?, hostKey?}.
   *
   * - no code → a new room under a random code, with a freshly issued hostKey.
   * - code of an EXISTING room → the caller must already hold that room's hostKey; it is echoed back
   *   (the host page's reload path). Anyone else gets `NOT_HOST` and **no key**: this call used to
   *   hand the key to whoever knew the 4-character code, which is everyone at the party (audit SG-01).
   * - code of a room that does NOT exist, with a hostKey this server issued for that code → the room
   *   is re-created under the same code and the same key (`restored: true`). Rooms live in memory, so
   *   this is what keeps a party's QR alive across a deploy/restart or the idle timeout. An existing
   *   room can never be taken this way, and a made-up key verifies for nothing.
   * - anything else → `unknown room code`.
   *
   * ROOM_FIXED_CODE (single-room demo mode, not used in production) is deliberately different: the
   * fixed room belongs to whoever opens the host page, so every call resolves to it and returns its
   * key — including a bare call, per docs/02-protocol.md §6 ("a fixed code survives a restart").
   */
  createRoom(requestedCode?: string, presentedKey?: string): { code: string; hostKey: string; restored?: boolean } | { error: string; status: number } {
    const fixed = this.opts.fixedCode;
    if (requestedCode) {
      const upper = requestedCode.toUpperCase();
      const existing = this.rooms.get(upper);
      if (existing) {
        if (upper === fixed || (typeof presentedKey === "string" && safeEqual(presentedKey, existing.hostKey))) return { code: upper, hostKey: existing.hostKey };
        return { error: "NOT_HOST", status: 403 };
      }
      if (this.canRestore(upper, presentedKey)) {
        if (this.isFull()) return { error: "server_full", status: 503 };
        const restoredRoom = this.spawn(upper, presentedKey);
        this.admitParked(restoredRoom);
        return { code: upper, hostKey: restoredRoom.hostKey, restored: true };
      }
      if (fixed && upper === fixed) return { code: upper, hostKey: this.spawn(upper).hostKey };
      return { error: "unknown room code", status: 400 };
    }
    if (fixed) {
      const room = this.rooms.get(fixed) ?? this.spawn(fixed);
      return { code: fixed, hostKey: room.hostKey };
    }
    if (this.isFull()) return { error: "server_full", status: 503 };
    const code = this.randomCode();
    const room = this.spawn(code);
    return { code, hostKey: room.hostKey };
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  getSummary(code: string): { code: string; exists: boolean; players: number } {
    const r = this.rooms.get(code.toUpperCase());
    return {
      code: code.toUpperCase(),
      exists: !!r,
      players: r ? Object.values(r.room.clients).filter((c) => c.kind === "player").length : 0,
    };
  }

  handleMessage(ws: WS, raw: string | Uint8Array) {
    const t = performance.now();
    const rate = ws.data.rate && t - ws.data.rate.windowStart < 1000 ? ws.data.rate : (ws.data.rate = { windowStart: t, count: 0 });
    if (++rate.count > MAX_MESSAGES_PER_SECOND) {
      // Over budget: drop it unparsed, and hang up once. A real client reconnects with backoff.
      if (rate.count === MAX_MESSAGES_PER_SECOND + 1) ws.close(1008, "rate limit");
      return;
    }
    const msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (!msg || !wireSafe(msg)) return send(ws, { type: "ERROR", code: "BAD_MESSAGE", message: "message failed schema validation" });
    if (msg.type === "JOIN") {
      // One socket, one seat. A socket that could JOIN again under a new client id each time left
      // every earlier record "connected" forever (its close only ever disconnects the last id), so a
      // single connection could mint records without bound and the room could never idle out.
      if (ws.data.roomCode !== null || ws.data.parked) return send(ws, { type: "ERROR", code: "ALREADY_JOINED", message: "this connection has already joined a room" });
      const caller = ws.data.ip ?? "local";
      const upper = msg.roomCode.toUpperCase();
      let room = this.rooms.get(upper);
      // A JOIN that proves it is the host of this code (the room's key, or a signed key that can
      // re-create it) is never held up by other people's misses on the same address: after a
      // restart every phone at the party misses at once, and the host's JOIN is the one that fixes it.
      const provenHost = msg.kind === "host" && typeof msg.hostKey === "string" && (room ? safeEqual(msg.hostKey, room.hostKey) : this.canRestore(upper, msg.hostKey));
      if (!provenHost && this.missedJoins.blocked(caller)) {
        // Same answer whether or not the room exists, so the reply says nothing about the code.
        send(ws, { type: "ERROR", code: "RATE_LIMITED", message: "too many attempts — wait a minute" });
        return ws.close(1008, "rate limit");
      }
      if (!room) {
        // The host's own socket reconnecting after a restart / the idle timeout brings the room back
        // under its old code, exactly like POST /rooms {code, hostKey} does: the signed key is the
        // proof. Players reconnecting to a vanished room cannot — they get NO_ROOM until the host is back.
        if (msg.kind === "host" && !this.isFull() && this.canRestore(upper, msg.hostKey)) {
          room = this.spawn(upper, msg.hostKey);
          room.join(ws, msg); // the host first, then everyone who was waiting for the room
          return this.admitParked(room);
        } else if (this.opts.fixedCode && upper === this.opts.fixedCode) room = this.spawn(upper);
        else if (performance.now() - this.bootAt < RESTART_GRACE_MS && this.isDealtCode(upper) && this.parkedTotal < MAX_PARKED_JOINS) {
          return this.park(ws, msg, upper);
        } else {
          this.missedJoins.allow(caller);
          return send(ws, { type: "ERROR", code: "NO_ROOM", message: `room ${msg.roomCode} does not exist` });
        }
      }
      return room.join(ws, msg);
    }
    const code = ws.data.roomCode;
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return; // stray message before JOIN or after the room is gone
    room.handle(ws, msg);
  }

  handleClose(ws: WS) {
    this.unpark(ws);
    const code = ws.data.roomCode;
    const room = code ? this.rooms.get(code) : undefined;
    room?.disconnect(ws);
  }
}
