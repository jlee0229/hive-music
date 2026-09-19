/**
 * The room: in-memory authoritative state plus every mutation the protocol allows.
 *
 * Invariants this file is responsible for (docs/02-protocol.md §7):
 *  - `assignment` on every client is always the pure output of `plan(room)` — call `replan()` after
 *    any change that can affect it, never hand-edit an assignment.
 *  - `ROOM_STATE` is a full snapshot, coalesced to ROOM_STATE_MAX_HZ. Coalescing is *leading edge*:
 *    the first change publishes immediately and later ones inside the window ride a trailing timer.
 *    A trailing-only implementation would eat up to 500 ms of the 600 ms PLAY lead.
 *  - A JOIN with a known clientId restores the record (joinIndex, position, pins, nudge, calibration).
 *  - Disconnected records survive DISCONNECT_RETENTION_MS, then disappear.
 */
import {
  CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, DISCONNECT_RETENTION_MS, IDLE_CALIBRATION,
  LEAD_MS, MAX_PLAYERS, PROTOCOL_VERSION, ROOM_STATE_MAX_HZ, STARTER_LATENCY_TABLE_MS,
  DEFAULT_CLICK_SPEC, DEFAULT_MODE, withAssignments, trackTimeSec,
  type ClientHealth, type ClientRecord, type ModeKind, type ModeParams, type RoomState, type ScenePlan,
  type ServerMessage, type StemRole, type TrackInfo, type Position,
} from "@hive/protocol";
import { serverNow } from "./clock";

/** The slice of a WebSocket the room needs; keeps the room unit-testable without a socket. */
export interface SocketLike {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface JoinRequest {
  clientId: string;
  kind: "host" | "player";
  plays: boolean;
  hostKey?: string;
  name?: string;
  device: ClientRecord["device"];
}

export type JoinResult = { ok: true; record: ClientRecord } | { ok: false; code: string; message: string };

const encode = (msg: ServerMessage) => JSON.stringify(msg);

export class Room {
  state: RoomState;
  readonly hostKey: string;
  /** Last time any socket in this room said anything; drives ROOM_IDLE_TTL_MS reaping. */
  lastActivityServerTime = serverNow();

  private joinCounter = 0;
  private readonly health = new Map<string, ClientHealth>();
  private readonly sockets = new Map<string, SocketLike>();
  private dirty = false;
  private lastPublishServerTime = 0;
  private trailingTimer: ReturnType<typeof setTimeout> | null = null;
  private calibrationTimers: ReturnType<typeof setTimeout>[] = [];
  private sceneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    code: string,
    hostKey: string,
    /** Publishes to every socket subscribed to this room's topic. */
    private readonly broadcast: (payload: string) => void,
  ) {
    this.hostKey = hostKey;
    this.state = {
      code,
      protocolVersion: PROTOCOL_VERSION,
      createdAtServerTime: serverNow(),
      hostClientIds: [],
      track: null,
      transport: { state: "stopped" },
      mode: DEFAULT_MODE,
      scenePlan: null,
      calibration: IDLE_CALIBRATION,
      clients: {},
    };
  }

  get code(): string {
    return this.state.code;
  }

  // ---- queries --------------------------------------------------------------
  isHost(clientId: string | null | undefined): boolean {
    return !!clientId && this.state.hostClientIds.includes(clientId);
  }
  client(clientId: string | null | undefined): ClientRecord | undefined {
    return clientId ? this.state.clients[clientId] : undefined;
  }
  playerCount(): number {
    return Object.values(this.state.clients).filter((c) => c.kind === "player").length;
  }
  connectedCount(): number {
    return Object.values(this.state.clients).filter((c) => c.connected).length;
  }
  healthSnapshot(): Record<string, ClientHealth> {
    const out: Record<string, ClientHealth> = {};
    for (const [id, h] of this.health) if (this.state.clients[id]) out[id] = h;
    return out;
  }

  // ---- lifecycle ------------------------------------------------------------
  /** JOIN. Restores an existing record when the clientId is known (reconnect or late refresh). */
  join(ws: SocketLike, req: JoinRequest): JoinResult {
    const existing = this.state.clients[req.clientId];
    if (!existing && this.playerCount() >= MAX_PLAYERS) {
      return { ok: false, code: "ROOM_FULL", message: `room is full (${MAX_PLAYERS})` };
    }
    // A host must present the room's hostKey; an id that is already a host stays one across reconnects.
    const wantsHost = req.kind === "host" && (req.hostKey === this.hostKey || existing?.kind === "host");
    const now = serverNow();

    const record: ClientRecord = existing
      ? { ...existing, connected: true, name: req.name ?? existing.name, device: req.device }
      : {
          id: req.clientId,
          kind: wantsHost ? "host" : "player",
          // Players are always speakers; a host opts in (SET_PLAYS or JOIN.plays).
          plays: wantsHost ? req.plays : true,
          name: req.name ?? `Phone ${this.joinCounter + 1}`,
          device: req.device,
          joinIndex: this.joinCounter++,
          joinedAtServerTime: now,
          position: null,
          pinnedRole: null,
          nudgeMs: 0,
          tableLatencyMs: STARTER_LATENCY_TABLE_MS[req.device.browserFamily],
          calibratedOffsetMs: null,
          assignment: null,
          connected: true,
          audioReadyTrackId: null,
        };

    this.state.clients[record.id] = record;
    if (record.kind === "host" && !this.state.hostClientIds.includes(record.id)) this.state.hostClientIds.push(record.id);
    this.sockets.set(record.id, ws);
    this.health.set(record.id, {
      rttMs: null,
      syncErrMs: null,
      outputLatencyMs: null,
      audioState: "locked",
      lastSeenServerTime: now,
    });
    this.touch();
    this.replan();
    return { ok: true, record };
  }

  /** Socket closed: keep the record (retention window) but mark it disconnected. */
  detach(clientId: string, ws?: SocketLike): void {
    if (ws && this.sockets.get(clientId) !== ws) return; // a newer socket already took the slot
    this.sockets.delete(clientId);
    const c = this.state.clients[clientId];
    if (!c) return;
    c.connected = false;
    this.markDirty();
  }

  /** Drops records that have been disconnected longer than DISCONNECT_RETENTION_MS. */
  purgeDisconnected(now = serverNow()): void {
    let changed = false;
    for (const c of Object.values(this.state.clients)) {
      if (c.connected || this.sockets.has(c.id)) continue;
      const h = this.health.get(c.id);
      const since = h?.lastSeenServerTime ?? c.joinedAtServerTime;
      if (now - since > DISCONNECT_RETENTION_MS) {
        delete this.state.clients[c.id];
        this.health.delete(c.id);
        this.state.hostClientIds = this.state.hostClientIds.filter((id) => id !== c.id);
        changed = true;
      }
    }
    if (changed) this.replan();
  }

  dispose(): void {
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    this.clearCalibrationTimers();
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    this.trailingTimer = null;
  }

  // ---- health / liveness ----------------------------------------------------
  touch(): void {
    this.lastActivityServerTime = serverNow();
  }
  seen(clientId: string): void {
    const h = this.health.get(clientId);
    if (h) h.lastSeenServerTime = serverNow();
    this.touch();
  }
  reportStatus(clientId: string, s: Omit<ClientHealth, "lastSeenServerTime">): void {
    this.health.set(clientId, { ...s, lastSeenServerTime: serverNow() });
    this.touch();
  }
  audioReady(clientId: string, trackId: string): void {
    const c = this.state.clients[clientId];
    if (!c || c.audioReadyTrackId === trackId) return;
    c.audioReadyTrackId = trackId;
    this.markDirty();
  }

  // ---- host controls --------------------------------------------------------
  setTrack(info: TrackInfo): void {
    this.state.track = info;
    this.state.transport = { state: "stopped" };
    for (const c of Object.values(this.state.clients)) if (c.audioReadyTrackId !== info.id) c.audioReadyTrackId = null;
    this.replan();
  }

  /** PLAY/SEEK put track zero LEAD_MS in the future so every phone has the same instant to aim at. */
  transport(action: "PLAY" | "PAUSE" | "SEEK", trackTimeSecArg?: number): void {
    const now = serverNow();
    if (action === "PLAY" || action === "SEEK") {
      const from = trackTimeSecArg ?? (this.state.transport.state === "paused" ? this.state.transport.trackTimeAtPause : 0);
      this.state.transport = { state: "playing", serverTimeAtTrackZero: now + LEAD_MS - from * 1000 };
      this.armSceneTimer();
    } else if (action === "PAUSE" && this.state.transport.state === "playing") {
      this.state.transport = { state: "paused", trackTimeAtPause: trackTimeSec(this.state.transport, now) };
      this.clearSceneTimer();
    }
    this.markDirty();
  }

  setMode(mode: ModeKind, params: ModeParams, opts: { clearScenePlan?: boolean; applyAtServerTime?: number | null } = {}): void {
    this.state.mode = { kind: mode, params };
    if (opts.clearScenePlan ?? true) {
      this.state.scenePlan = null; // a manual override wins over the plan
      this.clearSceneTimer();
    }
    this.replan(opts.applyAtServerTime ?? null);
  }

  assign(clientId: string, role: StemRole | null): void {
    const c = this.state.clients[clientId];
    if (!c) return;
    c.pinnedRole = role;
    this.replan();
  }

  setPosition(clientId: string, pos: Position): void {
    const c = this.state.clients[clientId];
    if (!c) return;
    c.position = pos;
    this.replan();
  }

  nudge(clientId: string, nudgeMs: number): void {
    const c = this.state.clients[clientId];
    if (!c || c.nudgeMs === nudgeMs) return;
    c.nudgeMs = nudgeMs;
    this.replan();
  }

  setPlays(clientId: string, plays: boolean): void {
    const c = this.state.clients[clientId];
    if (!c || c.plays === plays) return;
    c.plays = plays;
    this.replan();
  }

  kick(clientId: string): void {
    const c = this.state.clients[clientId];
    if (!c) return;
    const s = this.sockets.get(clientId);
    if (s) {
      s.send(encode({ type: "ERROR", code: "KICKED", message: "removed by host" }));
      s.close(1000, "kicked");
    }
    this.sockets.delete(clientId);
    this.health.delete(clientId);
    delete this.state.clients[clientId];
    this.state.hostClientIds = this.state.hostClientIds.filter((id) => id !== clientId);
    this.replan();
  }

  setScenePlan(plan: ScenePlan | null): void {
    this.state.scenePlan = plan;
    this.markDirty();
    if (plan) this.armSceneTimer();
    else this.clearSceneTimer();
  }

  // ---- calibration (Tier 2, docs/04) ---------------------------------------
  /**
   * Starts the tuning moment: the reference device listens, every *playing* other client gets one
   * scheduled click. Clients with plays=false are never in `order` (they make no sound to measure).
   */
  startCalibration(referenceClientId: string): void {
    this.clearCalibrationTimers();
    const order = Object.values(this.state.clients)
      .filter((c) => c.plays && c.connected && c.id !== referenceClientId)
      .sort((a, b) => a.joinIndex - b.joinIndex)
      .map((c) => c.id);
    const start = serverNow() + CALIBRATION_COUNTDOWN_MS;
    this.state.calibration = { state: "countdown", referenceClientId, startServerTime: start, order, results: {} };

    const ref = this.sockets.get(referenceClientId);
    if (ref) {
      ref.send(encode({
        type: "CALIBRATION_PLAN",
        startServerTime: start,
        intervalMs: CALIBRATION_CLICK_INTERVAL_MS,
        order,
        clickSpec: DEFAULT_CLICK_SPEC,
      }));
    }
    // Every click is scheduled up front: the phone needs the lead time to render it at the exact ctx time.
    order.forEach((id, i) => {
      const s = this.sockets.get(id);
      if (!s) return;
      s.send(encode({
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: start + i * CALIBRATION_CLICK_INTERVAL_MS,
        action: { kind: "CALIBRATION_CLICK", clickId: `${id}:${i}`, clickSpec: DEFAULT_CLICK_SPEC },
      }));
    });

    this.calibrationTimers.push(setTimeout(() => {
      if (this.state.calibration.state !== "countdown") return;
      this.state.calibration = { ...this.state.calibration, state: "running" };
      this.markDirty();
    }, CALIBRATION_COUNTDOWN_MS));

    // If the reference never reports, the host's promise must still resolve.
    const window = CALIBRATION_COUNTDOWN_MS + order.length * CALIBRATION_CLICK_INTERVAL_MS + 5000;
    this.calibrationTimers.push(setTimeout(() => {
      if (this.state.calibration.state === "done") return;
      this.state.calibration = { ...this.state.calibration, state: "failed" };
      this.markDirty();
    }, window));

    this.markDirty();
  }

  /** Accumulates residuals: calibratedOffsetMs = (calibrated ?? table ?? 0) + residual. */
  applyCalibrationReport(measurements: Array<{ clientId: string; residualMs: number; confidence: number }>): void {
    for (const m of measurements) {
      const c = this.state.clients[m.clientId];
      if (!c) continue;
      c.calibratedOffsetMs = (c.calibratedOffsetMs ?? c.tableLatencyMs ?? 0) + m.residualMs;
      this.state.calibration.results[m.clientId] = { residualMs: m.residualMs, confidence: m.confidence };
    }
    this.state.calibration = { ...this.state.calibration, state: "done" };
    this.clearCalibrationTimers();
    this.replan();
  }

  private clearCalibrationTimers(): void {
    for (const t of this.calibrationTimers) clearTimeout(t);
    this.calibrationTimers = [];
  }

  // ---- scene timer (B6) ----------------------------------------------------
  /** Fires LEAD_MS before each scene boundary; the mode change carries applyAtServerTime = boundary. */
  armSceneTimer(): void {
    this.clearSceneTimer();
    const plan = this.state.scenePlan;
    if (!plan || this.state.transport.state !== "playing") return;
    const zero = this.state.transport.serverTimeAtTrackZero;
    const now = serverNow();
    const next = plan.scenes
      .map((s) => ({ scene: s, boundary: zero + s.atTrackSec * 1000 }))
      .find((s) => s.boundary - LEAD_MS > now);
    if (!next) return;
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      if (this.state.scenePlan !== plan) return; // plan replaced while waiting
      this.setMode(next.scene.mode, next.scene.params, { clearScenePlan: false, applyAtServerTime: next.boundary });
      this.flush(); // scene boundaries are time-critical: publish now, not on the trailing timer
      this.armSceneTimer();
    }, Math.max(0, next.boundary - LEAD_MS - now));
  }
  private clearSceneTimer(): void {
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    this.sceneTimer = null;
  }

  // ---- planning + publishing ----------------------------------------------
  /** Recomputes every assignment and marks the room dirty. The only way assignments ever change. */
  replan(applyAtServerTime: number | null = null): void {
    this.state = withAssignments(this.state, applyAtServerTime);
    this.markDirty();
  }

  markDirty(): void {
    this.dirty = true;
    const since = serverNow() - this.lastPublishServerTime;
    const minGap = 1000 / ROOM_STATE_MAX_HZ;
    if (since >= minGap) {
      this.flush();
    } else if (!this.trailingTimer) {
      this.trailingTimer = setTimeout(() => {
        this.trailingTimer = null;
        this.flush();
      }, minGap - since);
    }
  }

  /** Publishes the full snapshot if anything changed. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastPublishServerTime = serverNow();
    this.broadcast(encode({ type: "ROOM_STATE", room: this.state }));
  }

  /** Sends the current snapshot to one socket regardless of coalescing (joiners, reconnects). */
  sendSnapshot(ws: SocketLike): void {
    ws.send(encode({ type: "ROOM_STATE", room: this.state }));
  }

  sendTo(clientId: string, msg: ServerMessage): void {
    this.sockets.get(clientId)?.send(encode(msg));
  }

  /** HEALTH goes to hosts only (1 Hz); players never learn about each other's numbers. */
  publishHealth(): void {
    if (this.state.hostClientIds.length === 0) return;
    const msg = encode({ type: "HEALTH", serverTime: serverNow(), clients: this.healthSnapshot() });
    for (const id of this.state.hostClientIds) this.sockets.get(id)?.send(msg);
  }

  publishPing(): void {
    this.broadcast(encode({ type: "PING", serverTime: serverNow() }));
  }
}
