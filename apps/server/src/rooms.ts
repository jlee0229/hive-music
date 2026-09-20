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
import { currentScene, nextScene } from "./scene-timer";
import { loadLibrary, type LibraryEntry } from "./library";

const now = () => performance.timeOrigin + performance.now();

export type Conn = { clientId: string | null; roomCode: string | null };
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

/** One room: state + sockets + every timer that keeps it alive. */
export class Room {
  code: string;
  hostKey: string;
  room: RoomState;
  sockets = new Map<string, WS>();
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

  constructor(
    code: string,
    private server: Bun.Server<Conn>,
    private onEmpty: () => void,
    private getLibrary: () => LibraryEntry[],
  ) {
    this.code = code;
    this.hostKey = crypto.randomUUID();
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
  }

  // ---- lifecycle -------------------------------------------------------------
  destroy() {
    clearInterval(this.healthTimer);
    clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    for (const t of this.calibrationTimers) clearTimeout(t);
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
      this.server.publish(this.code, JSON.stringify({ type: "ROOM_STATE", room: this.room } satisfies ServerMessage));
    } else if (!this.trailingTimer) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        this.flush();
      }, minGapMs - elapsed + Room.TRAILING_GUARD_MS);
    }
  }

  private publishHealth() {
    const t = now();
    const clients: Record<string, HealthRecord> = {};
    for (const [id, h] of this.health) if (this.room.clients[id]) clients[id] = h;
    for (const id of this.room.hostClientIds) {
      const s = this.sockets.get(id);
      if (s) send(s, { type: "HEALTH", serverTime: t, clients });
    }
  }

  private tickPing() {
    const t = now();
    for (const [id, s] of this.sockets) {
      const h = this.health.get(id);
      if (h && t - h.lastSeenServerTime > 2 * PING_INTERVAL_MS + 5000) s.close(1001, "ping timeout");
    }
    this.server.publish(this.code, JSON.stringify({ type: "PING", serverTime: t } satisfies ServerMessage));
  }

  private setTrack(t: LibraryEntry) {
    const info: TrackInfo = { id: t.id, title: t.title, durationSec: t.durationSec, stems: t.stems, bpm: t.bpm };
    this.room.track = info;
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
   * phone silent (a 60s demo track ends and the party just… stops, while the UI still says playing).
   * The loop timer restarts the track at its own end, seamlessly: it fires LEAD_MS before the
   * boundary and moves serverTimeAtTrackZero to exactly the old end, so every phone gets the new
   * transport with the standard lead and schedules the restart on the boundary instant itself.
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
    // Seamless when the boundary is still comfortably ahead (the normal case: this fires LEAD_MS
    // early); a boundary too close or already past (a SEEK beyond the end, or a room found stuck
    // from before this timer existed) restarts with the standard lead instead — a
    // serverTimeAtTrackZero in the past would start mid-track.
    const zero = endServerTime > now() + 100 ? endServerTime : now() + LEAD_MS;
    this.room.transport = { state: "playing", serverTimeAtTrackZero: zero };
    this.dirty = true;
    this.flush();
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
    if (this.room.calibration.state === "idle" || this.room.calibration.state === "failed") return;
    for (const m of msg.measurements) {
      const c = this.room.clients[m.clientId];
      if (!c || m.confidence < 0.5) continue; // low-confidence peaks are ignored
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
    // userAgent (up to 512 chars, required by DeviceInfoSchema) is dead weight on every ROOM_STATE
    // broadcast — nothing server-side reads it, only browserFamily/platform/model do — and it's most
    // of a snapshot's size at scale (~26-30KB at 30 phones). Never store the real string.
    const device = { ...msg.device, userAgent: "" };
    // A ROOM_FIXED_CODE demo room re-spawned lazily (after ROOM_IDLE_TTL_MS, or a restart) mints a
    // fresh hostKey (constructor above) that the host's stored key can never match, and there is no
    // `existing` record for a brand-new room either — so without the "nobody holds the room yet"
    // clause, the host would be silently demoted to a player forever (every host command then answers
    // NOT_HOST). Accepting kind:"host" once hostClientIds is empty recovers that, and is also what lets
    // an existing PLAYER record (a host demoted by this exact gap before this fix landed) be promoted
    // back once it presents the room's real hostKey.
    const wantsHost = msg.kind === "host" && (msg.hostKey === this.hostKey || existing?.kind === "host" || this.room.hostClientIds.length === 0);
    // A viewer (v4, the /screen projector) is read-only: plays is forced false whatever the JOIN
    // says, it never lands in hostClientIds, and it must not be coerced to "player" — that made
    // every projector a phantom speaker that stole a stem in ORCHESTRA and padded the player count.
    const isViewer = !wantsHost && msg.kind === "viewer";
    const rec: ClientRecord = existing
      ? { ...existing, connected: true, name: msg.name ?? existing.name, device, kind: wantsHost ? "host" : existing.kind, plays: wantsHost ? msg.plays : existing.kind === "viewer" ? false : existing.plays }
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

    ws.data.clientId = rec.id;
    ws.data.roomCode = this.code;
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

  disconnect(ws: WS) {
    const id = ws.data.clientId;
    if (!id) return;
    // A duplicate/stale socket for the same clientId (e.g. a reconnect that raced the old socket's
    // close) must not tear down the live one — join() always makes the newest socket the one
    // registered in `this.sockets`, so if this isn't it, the client is still connected elsewhere.
    if (this.sockets.get(id) !== ws) return;
    const c = this.room.clients[id];
    if (c) {
      c.connected = false;
      this.dirty = true;
      this.flush();
    }
    this.sockets.delete(id);
    this.clearDisconnectTimer(id);
    const timer = setTimeout(() => {
      delete this.room.clients[id];
      this.room.hostClientIds = this.room.hostClientIds.filter((hid) => hid !== id);
      this.disconnectTimers.delete(id);
      this.dirty = true;
      this.flush();
      this.checkIdle();
    }, DISCONNECT_RETENTION_MS);
    this.disconnectTimers.set(id, timer);
  }

  // ---- message dispatch ---------------------------------------------------------
  handle(ws: WS, msg: ClientMessage) {
    const me = ws.data.clientId ? this.room.clients[ws.data.clientId] : undefined;
    const isHost = !!me && this.room.hostClientIds.includes(me.id);
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
        if (me) this.health.get(me.id)!.lastSeenServerTime = now();
        return;
      case "CLIENT_STATUS":
        if (me) {
          this.health.set(me.id, { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs: msg.outputLatencyMs, audioState: msg.audioState, lastSeenServerTime: now() });
          // A phone that reports a live ctx.outputLatency knows its own output path better than the
          // starter table's per-family guess. Nulling tableLatencyMs makes the client subtract that
          // live value itself (useOutputLatency: "no table AND no calibration"), and the replan drops
          // the guess from compensationMs in the same ROOM_STATE snapshot — so the two sides can never
          // double-count. One-way and self-extinguishing: table never comes back, and a later
          // calibration still accumulates onto health.outputLatencyMs (the report handler's base).
          if (me.calibratedOffsetMs == null && me.tableLatencyMs != null && msg.outputLatencyMs != null && msg.outputLatencyMs > 0) {
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
        if (me?.kind === "host") {
          me.plays = msg.plays;
          this.replan();
        }
        return;
      case "SET_TRACK": {
        if (!hostOnly()) return;
        const track = this.getLibrary().find((t) => t.id === msg.trackId);
        if (!track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: `unknown track ${msg.trackId}` });
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
          const s = this.sockets.get(msg.clientId);
          if (s) {
            send(s, { type: "ERROR", code: "KICKED", message: "removed by host" });
            s.close();
          }
          this.sockets.delete(msg.clientId);
          this.clearDisconnectTimer(msg.clientId);
          delete this.room.clients[msg.clientId];
          this.room.hostClientIds = this.room.hostClientIds.filter((id) => id !== msg.clientId);
          this.replan();
          this.checkIdle();
        }
        return;
      case "CALIBRATION_START":
        if (!hostOnly()) return;
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

  constructor(private opts: { fixturesDir: string; fixedCode?: string }) {}

  attachServer(server: Bun.Server<Conn>) {
    this.server = server;
  }

  async loadLibrary() {
    this.library = await loadLibrary(this.opts.fixturesDir);
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
    for (const room of this.rooms.values()) if (room.hostKey === key) return true;
    return false;
  }

  private randomCode(): string {
    let code: string;
    do {
      code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  private spawn(code: string): Room {
    if (!this.server) throw new Error("RoomManager.attachServer must be called before spawning rooms");
    const room: Room = new Room(
      code,
      this.server,
      () => {
        room.destroy();
        this.rooms.delete(code);
      },
      () => this.library,
    );
    this.rooms.set(code, room);
    return room;
  }

  /**
   * POST /rooms {code?} — a fixed code always resolves to the same room (including a *bare* call with
   * no code, per docs/02-protocol.md §6: "a fixed code survives a restart" — a restart issuing a fresh
   * hostKey is fine, since the host re-creates and presents it, but the code the printed QR encodes
   * must not change). A requested code that is neither an existing room nor the fixed code is rejected.
   */
  createRoom(requestedCode?: string): { code: string; hostKey: string } | { error: string } {
    if (requestedCode) {
      const upper = requestedCode.toUpperCase();
      const existing = this.rooms.get(upper);
      if (existing) return { code: upper, hostKey: existing.hostKey };
      if (this.opts.fixedCode && upper === this.opts.fixedCode) {
        const room = this.spawn(upper);
        return { code: upper, hostKey: room.hostKey };
      }
      return { error: "unknown room code" };
    }
    if (this.opts.fixedCode) {
      const existing = this.rooms.get(this.opts.fixedCode);
      if (existing) return { code: this.opts.fixedCode, hostKey: existing.hostKey };
      const room = this.spawn(this.opts.fixedCode);
      return { code: this.opts.fixedCode, hostKey: room.hostKey };
    }
    const code = this.randomCode();
    const room = this.spawn(code);
    return { code, hostKey: room.hostKey };
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
    const msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (!msg) return send(ws, { type: "ERROR", code: "BAD_MESSAGE", message: "message failed schema validation" });
    if (msg.type === "JOIN") {
      const upper = msg.roomCode.toUpperCase();
      let room = this.rooms.get(upper);
      if (!room) {
        if (this.opts.fixedCode && upper === this.opts.fixedCode) room = this.spawn(upper);
        else return send(ws, { type: "ERROR", code: "NO_ROOM", message: `room ${msg.roomCode} does not exist` });
      }
      return room.join(ws, msg);
    }
    const code = ws.data.roomCode;
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return; // stray message before JOIN or after the room is gone
    room.handle(ws, msg);
  }

  handleClose(ws: WS) {
    const code = ws.data.roomCode;
    const room = code ? this.rooms.get(code) : undefined;
    room?.disconnect(ws);
  }
}
