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
  type TrackLibraryEntry,
} from "@hive/protocol";
import { currentScene, nextScene } from "./scene-timer";
import { loadLibrary } from "./library";

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
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setInterval>;
  private healthTimer: ReturnType<typeof setInterval>;
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(
    code: string,
    private server: Bun.Server<Conn>,
    private onEmpty: () => void,
    private getLibrary: () => TrackLibraryEntry[],
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
    this.stateTimer = setInterval(() => this.flush(), 1000 / ROOM_STATE_MAX_HZ);
    this.healthTimer = setInterval(() => this.publishHealth(), 1000 / HEALTH_HZ);
    this.pingTimer = setInterval(() => this.tickPing(), PING_INTERVAL_MS);
  }

  // ---- lifecycle -------------------------------------------------------------
  destroy() {
    clearInterval(this.stateTimer);
    clearInterval(this.healthTimer);
    clearInterval(this.pingTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
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
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.server.publish(this.code, JSON.stringify({ type: "ROOM_STATE", room: this.room } satisfies ServerMessage));
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

  private setTrack(t: TrackLibraryEntry) {
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
    this.replan(boundaryServerTime);
    this.flush();
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

  /** Called by the vibe route (B6) once a plan is accepted. */
  acceptScenePlan(plan: ScenePlan) {
    this.room.scenePlan = plan;
    if (this.room.transport.state === "playing") this.syncModeToScenePlan();
    else this.dirty = true;
    this.rearmSceneTimer();
    this.flush();
  }

  // ---- calibration (B8s) -------------------------------------------------------
  private startCalibration(referenceClientId: string) {
    for (const t of this.calibrationTimers) clearTimeout(t);
    this.calibrationTimers = [];

    const order = Object.values(this.room.clients)
      .filter((c) => c.plays && c.id !== referenceClientId)
      .sort((a, b) => a.joinIndex - b.joinIndex)
      .map((c) => c.id);
    const start = now() + CALIBRATION_COUNTDOWN_MS;
    this.room.calibration = { state: "countdown", referenceClientId, startServerTime: start, order, results: {} };
    this.dirty = true;

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
        }
      }, CALIBRATION_COUNTDOWN_MS),
      setTimeout(
        () => {
          if (this.room.calibration.state !== "done") {
            this.room.calibration = { ...this.room.calibration, state: "failed" };
            this.dirty = true;
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
      c.calibratedOffsetMs = (c.calibratedOffsetMs ?? c.tableLatencyMs ?? 0) + m.residualMs;
      this.room.calibration.results[m.clientId] = { residualMs: m.residualMs, confidence: m.confidence };
    }
    this.room.calibration = { ...this.room.calibration, state: "done" };
    this.replan();
  }

  // ---- join / disconnect --------------------------------------------------------
  join(ws: WS, msg: Extract<ClientMessage, { type: "JOIN" }>) {
    const existing = this.room.clients[msg.clientId];
    const wantsHost = msg.kind === "host" && (msg.hostKey === this.hostKey || existing?.kind === "host");
    const rec: ClientRecord = existing
      ? { ...existing, connected: true, name: msg.name ?? existing.name, device: msg.device }
      : {
          id: msg.clientId,
          kind: wantsHost ? "host" : "player",
          plays: wantsHost ? msg.plays : true,
          name: msg.name ?? `Phone ${this.joinCounter + 1}`,
          device: msg.device,
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
    this.replan();
    this.flush(); // a joiner gets its snapshot immediately
  }

  disconnect(ws: WS) {
    const id = ws.data.clientId;
    if (!id) return;
    const c = this.room.clients[id];
    if (c) {
      c.connected = false;
      this.dirty = true;
    }
    this.sockets.delete(id);
    this.clearDisconnectTimer(id);
    const timer = setTimeout(() => {
      delete this.room.clients[id];
      this.room.hostClientIds = this.room.hostClientIds.filter((hid) => hid !== id);
      this.disconnectTimers.delete(id);
      this.dirty = true;
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
        if (me) this.health.set(me.id, { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs: msg.outputLatencyMs, audioState: msg.audioState, lastSeenServerTime: now() });
        return;
      case "AUDIO_READY":
        if (me) {
          me.audioReadyTrackId = msg.trackId;
          this.dirty = true;
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
          this.syncModeToScenePlan();
          this.rearmSceneTimer();
        } else if (msg.action === "PAUSE" && this.room.transport.state === "playing") {
          this.room.transport = { state: "paused", trackTimeAtPause: trackTimeSec(this.room.transport, t) };
          this.dirty = true;
          this.cancelSceneTimer();
        }
        return;
      }
      case "SET_MODE":
        if (!hostOnly()) return;
        this.room.mode = { kind: msg.mode, params: msg.params };
        this.room.scenePlan = null; // manual override wins
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
      case "CALIBRATION_REPORT":
        return this.handleCalibrationReport(me, msg);
    }
  }
}

/** Owns every room in the process; one Fly machine only (rooms live in memory). */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private server: Bun.Server<Conn> | null = null;
  private library: TrackLibraryEntry[] = [];

  constructor(private opts: { fixturesDir: string; fixedCode?: string }) {}

  attachServer(server: Bun.Server<Conn>) {
    this.server = server;
  }

  async loadLibrary(origin: string) {
    this.library = await loadLibrary(this.opts.fixturesDir, origin);
  }

  getLibrary(): TrackLibraryEntry[] {
    return this.library;
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

  /** POST /rooms {code?} — a fixed code always resolves to the same room; a mismatched requested code is rejected. */
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
