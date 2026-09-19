/**
 * `createHiveClient` — the real engine. Transport and reconnect come from transport.ts (shared with
 * the stub); the clock from clock.ts; the audio graph and scheduler from audio.ts (gate B3).
 *
 * Probe sending is the one place where the clock and the audio graph must touch: `ctx.currentTime` is
 * sampled in the *same synchronous tick* as the probe's `t0`, so a server time maps to a ctx time
 * through one relation instead of two. That is why the sampler is injected here rather than read
 * inside CtxMapper.
 */
import {
  CLIENT_STATUS_INTERVAL_MS, NTP_BURST_COUNT, NTP_BURST_WINDOW_MS, NTP_STEADY_INTERVAL_MS,
  SET_POSITION_MAX_HZ, computeSyncErrMs, trackTimeSec as transportTrackTimeSec,
  type Assignment, type AudioState, type ClientMessage, type ClientRecord, type HealthSnapshot,
  type ModeKind, type ModeParams, type RoomState, type ScenePlan, type ServerMessage, type StemRole,
} from "@hive/protocol";
import { createBrowserAudioEngine } from "./audio";
import { ClockModel, CtxMapper, localNow } from "./clock";
import type { StartDecision } from "./scheduler";
import { Emitter, persistedClientId, RoomTransport } from "./transport";
import type {
  CalibrationResult, ConnectionState, HiveAudio, HiveCalibration, HiveClient, HiveClientOptions, SyncStatus,
} from "./index";

/**
 * What the engine needs from an audio implementation. B3 supplies the real one; B2 ships
 * `nullAudioEngine`, which is honest about having no output rather than pretending to be ready.
 */
export interface AudioEngine extends HiveAudio {
  /** Sampled with each probe: ctx.currentTime, or null when no context exists yet. */
  ctxNow(): number | null;
  /** A new snapshot arrived: (re)schedule from room.transport and the assignment. */
  applyRoom(room: RoomState, assignment: Assignment | null): void;
  /** Last hard resync applied to the playhead, ms. */
  readonly lastCorrectionMs: number;
  /** `ctx.outputLatency` when the browser exposes it, ms; null otherwise. */
  readonly outputLatencyMs: number | null;
  /** Schedules a calibration click to leave the speaker at this server time. */
  scheduleClick(serverTimeToExecute: number, spec: import("@hive/protocol").ClickSpec): void;
  /** The server sends CALIBRATION_PLAN to the reference only; the engine hands it to `runAsReference`. */
  onCalibrationPlan(plan: Extract<ServerMessage, { type: "CALIBRATION_PLAN" }>): void;
  calibration: HiveCalibration;
  /**
   * Scheduling diagnostics for /diag, the measurement rig and tests. Not part of the frozen
   * `HiveClient` surface. `startCtxForZero` is the ctx time at which track position 0 leaves this
   * device's speaker — map it back through `CtxMapper.serverTimeForCtx` and two phones become
   * comparable in the only frame that matters, the server clock.
   */
  readonly debug: EngineDebug;
  dispose(): void;
}

export interface EngineDebug {
  startCtxForZero: number | null;
  lastDecision: StartDecision | null;
  playing: boolean;
  ctxState: string | null;
  loadedTrackId: string | null;
}

/** Placeholder engine for B2: connects and syncs, plays nothing, and says so. */
export function nullAudioEngine(): AudioEngine {
  let muted = false;
  return {
    async unlock() {
      throw new Error("@hive/sync-client: audio engine lands in gate B3; use createStubClient for UI work");
    },
    get state(): AudioState {
      return "locked";
    },
    get loadProgress() {
      return 0;
    },
    setMuted(m: boolean) {
      muted = m;
    },
    get muted() {
      return muted;
    },
    ctxNow: () => null,
    applyRoom: () => {},
    lastCorrectionMs: 0,
    outputLatencyMs: null,
    debug: { startCtxForZero: null, lastDecision: null, playing: false, ctxState: null, loadedTrackId: null },
    scheduleClick: () => {},
    onCalibrationPlan: () => {},
    calibration: {
      async runAsReference(): Promise<CalibrationResult> {
        throw new Error("@hive/sync-client: calibration lands in gate B8");
      },
      renderClick: () => new Float32Array(0),
    },
    dispose: () => {},
  };
}

export interface CreateHiveClientInternals {
  /**
   * Injected by tests (and by the rig) to supply a fake AudioContext. Defaults to the real browser
   * engine where Web Audio exists, and to the null engine where it does not — so importing the package
   * in Node or Bun never throws at module load.
   */
  createAudioEngine?: (ctx: AudioEngineContext) => AudioEngine;
}

/** True when this runtime can actually play audio (a browser with Web Audio). */
const hasWebAudio = (): boolean => typeof globalThis.AudioContext !== "undefined" && typeof document !== "undefined";

/** What an audio engine gets handed: the clock, the mapper, a sender and the emitter. */
export interface AudioEngineContext {
  opts: HiveClientOptions;
  clock: ClockModel;
  mapper: CtxMapper;
  emit: Emitter;
  send: (msg: ClientMessage) => void;
  clientId: string;
  room: () => RoomState | null;
  /** `localNow()`, injected so a test can drive time without touching performance.now(). */
  now: () => number;
}

export function createHiveClient(opts: HiveClientOptions, internals: CreateHiveClientInternals = {}): HiveClient {
  const clientId = opts.clientId ?? persistedClientId(opts.roomCode);
  const clock = new ClockModel({ pairs: true });
  const mapper = new CtxMapper(clock);
  const ev = new Emitter();

  let room: RoomState | null = null;
  let timers: Array<ReturnType<typeof setInterval>> = [];
  let pairTimer: ReturnType<typeof setTimeout> | null = null;
  let probeGroup = 0;
  let lastPositionSent = 0;
  let positionFlush: ReturnType<typeof setTimeout> | null = null;

  const me = (): ClientRecord | null => (room && clientId in room.clients ? room.clients[clientId]! : null);
  const assignmentOf = (): Assignment | null => me()?.assignment ?? null;

  const transport: RoomTransport = new RoomTransport(
    opts,
    clientId,
    {
      onWelcome: () => {
        clock.onReconnect();
        startTimers();
      },
      onConnection: (state) => ev.emit("connection", state),
      onReconnect: () => {
        stopTimers();
        clock.onReconnect();
      },
      onMessage: (msg, at) => handleMessage(msg, at),
    },
    localNow,
  );

  const makeEngine = internals.createAudioEngine ?? (hasWebAudio() ? createBrowserAudioEngine : nullAudioEngine);
  const audio: AudioEngine = makeEngine({
    opts,
    clock,
    mapper,
    emit: ev,
    send: (m) => transport.send(m),
    clientId,
    room: () => room,
    now: localNow,
  });

  const status = (): SyncStatus => ({
    clockOffsetMs: clock.offsetMs,
    rttMs: clock.rttMs,
    syncErrMs: clock.rttMs == null ? null : computeSyncErrMs(clock.rttMs, audio.lastCorrectionMs),
    outputLatencyMs: audio.outputLatencyMs,
    compensationMs: assignmentOf()?.compensationMs ?? 0,
    lastCorrectionMs: audio.lastCorrectionMs,
    playing: room?.transport.state === "playing",
  });

  function handleMessage(msg: ServerMessage, at: number): void {
    switch (msg.type) {
      case "NTP_RESPONSE":
        clock.addProbe(msg.t0, msg.t1, msg.t2, at, msg.probeGroupId, msg.probeGroupIndex);
        ev.emit("status", status());
        break;
      case "ROOM_STATE": {
        const previous = JSON.stringify(assignmentOf());
        room = msg.room;
        ev.emit("state", room);
        const next = assignmentOf();
        if (previous !== JSON.stringify(next)) ev.emit("assignment", next);
        audio.applyRoom(room, next);
        break;
      }
      case "HEALTH":
        ev.emit("health", msg.clients as Record<string, HealthSnapshot>, msg.serverTime);
        break;
      case "PING":
        transport.send({ type: "PONG" });
        break;
      case "SCHEDULED_ACTION":
        if (msg.action.kind === "CALIBRATION_CLICK") {
          audio.scheduleClick(msg.serverTimeToExecute, msg.action.clickSpec);
          ev.emit("calibrationClick", msg.serverTimeToExecute);
        }
        break;
      case "CALIBRATION_PLAN":
        audio.onCalibrationPlan(msg);
        break;
      case "ERROR":
        ev.emit("error", msg.code, msg.message);
        if (msg.code === "KICKED") {
          transport.stopReconnecting();
          room = null;
        }
        break;
    }
  }

  /**
   * One coded pair: two probes NTP_PROBE_PAIR_GAP_MS apart sharing a group id. `ctx.currentTime` is
   * sampled beside each `t0` in the same tick — that pairing is the whole point (docs/03).
   */
  function probe(): void {
    const id = probeGroup++;
    const sendOne = (index: 0 | 1) => {
      const t0 = localNow();
      const ctx = audio.ctxNow();
      if (ctx !== null) mapper.addSample(t0, ctx);
      transport.send({ type: "NTP_REQUEST", t0, probeGroupId: id, probeGroupIndex: index });
    };
    sendOne(0);
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = setTimeout(() => {
      pairTimer = null;
      sendOne(1);
    }, ClockModel.pairGapMs);
  }

  function startTimers(): void {
    stopTimers();
    // A burst of NTP_BURST_COUNT pairs across NTP_BURST_WINDOW_MS, then steady state at 1 Hz.
    let n = 0;
    const burst = setInterval(() => {
      probe();
      if (++n >= NTP_BURST_COUNT) clearInterval(burst);
    }, NTP_BURST_WINDOW_MS / NTP_BURST_COUNT);
    timers.push(burst, setInterval(probe, NTP_STEADY_INTERVAL_MS));
    timers.push(
      setInterval(() => {
        const s = status();
        transport.send({
          type: "CLIENT_STATUS",
          rttMs: s.rttMs,
          syncErrMs: s.syncErrMs,
          outputLatencyMs: s.outputLatencyMs,
          audioState: audio.state,
        });
      }, CLIENT_STATUS_INTERVAL_MS),
    );
    probe(); // do not wait a tick for the first sample
  }

  function stopTimers(): void {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = null;
  }

  const client: HiveClient = {
    clientId,
    get room() {
      return room;
    },
    get me() {
      return me();
    },
    get assignment() {
      return assignmentOf();
    },
    get connection(): ConnectionState {
      return transport.connection;
    },
    get status() {
      return status();
    },
    clock: {
      serverNow: () => clock.serverNow(),
      trackTimeSec: () => (room ? transportTrackTimeSec(room.transport, clock.serverNow()) : 0),
      ctxTimeFor: (serverTime) => mapper.ctxTimeFor(serverTime),
    },
    get audio(): HiveAudio {
      return audio;
    },
    host: {
      setTrack: (trackId) => transport.send({ type: "SET_TRACK", trackId }),
      play: (trackTimeSec) => transport.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec }),
      pause: () => transport.send({ type: "TRANSPORT", action: "PAUSE" }),
      seek: (trackTimeSec) => transport.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec }),
      setMode: (mode: ModeKind, params: ModeParams = {}) => transport.send({ type: "SET_MODE", mode, params }),
      assign: (id: string, role: StemRole | null) => transport.send({ type: "ASSIGN", clientId: id, role }),
      /**
       * Throttled to SET_POSITION_MAX_HZ inside the engine, and the *last* value always gets through:
       * a drag that ends mid-window would otherwise leave the dot where it was, not where it was
       * dropped (docs/03 calls this out as the assumption to honour).
       */
      setPosition: (id, x, y) => {
        const clamped = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
        const now = localNow();
        const gap = 1000 / SET_POSITION_MAX_HZ;
        if (positionFlush) clearTimeout(positionFlush);
        if (now - lastPositionSent >= gap) {
          lastPositionSent = now;
          transport.send({ type: "SET_POSITION", clientId: id, ...clamped });
          return;
        }
        positionFlush = setTimeout(() => {
          positionFlush = null;
          lastPositionSent = localNow();
          transport.send({ type: "SET_POSITION", clientId: id, ...clamped });
        }, gap - (now - lastPositionSent));
      },
      nudge: (id, nudgeMs) => transport.send({ type: "NUDGE", clientId: id, nudgeMs: Math.round(nudgeMs) }),
      setPlays: (plays) => transport.send({ type: "SET_PLAYS", plays }),
      kick: (id) => transport.send({ type: "KICK", clientId: id }),
      async startCalibration() {
        transport.send({ type: "CALIBRATION_START", referenceClientId: clientId });
        await new Promise<void>((resolve) => {
          const off = ev.on("state", (r) => {
            if (r.calibration.state === "done" || r.calibration.state === "failed") {
              off();
              resolve();
            }
          });
        });
      },
      async vibe(prompt: string): Promise<ScenePlan> {
        const res = await fetch(`${opts.apiUrl}/rooms/${opts.roomCode}/vibe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) throw new Error(`vibe failed: ${res.status}`);
        return ((await res.json()) as { scenePlan: ScenePlan }).scenePlan;
      },
    },
    get calibration() {
      return audio.calibration;
    },
    nudgeSelf: (nudgeMs) => transport.send({ type: "NUDGE", clientId, nudgeMs: Math.round(nudgeMs) }),
    connect: () => transport.connect(),
    disconnect: () => {
      stopTimers();
      if (positionFlush) clearTimeout(positionFlush);
      audio.dispose();
      transport.disconnect();
    },
    on: (e, h) => ev.on(e, h),
    off: (e, h) => ev.off(e, h),
  };

  return client;
}
