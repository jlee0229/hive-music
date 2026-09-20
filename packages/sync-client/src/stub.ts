/**
 * createStubClient — a HiveClient with REAL protocol plumbing and NO audio.
 * Speaks the full WebSocket contract (JOIN, NTP probes with min-RTT selection, ROOM_STATE, HEALTH,
 * PING/PONG, host controls, CLIENT_STATUS) so the frontend can build every screen against the mock
 * server, and Playwright tests stay deterministic. `audio.unlock()` fakes a download and reports
 * "ready"; nothing is ever played.
 *
 * Socket lifecycle, reconnect and the clock come from the same transport.ts/clock.ts the real engine
 * uses — there is one implementation of each, and this file is the one that keeps it honest in CI.
 * Coded-pair *validation* is deliberately off here: the stub protects no audio and must never end up
 * without a clock because a CI runner hiccupped. It still sends the pair ids, so the server's echo path
 * is exercised.
 */
import {
  CLIENT_STATUS_INTERVAL_MS, NTP_BURST_COUNT, NTP_BURST_WINDOW_MS, NTP_STEADY_INTERVAL_MS, SET_POSITION_MAX_HZ,
  trackTimeSec as transportTrackTimeSec,
  type Assignment, type AudioState, type ClientRecord, type HealthSnapshot, type ModeKind, type ModeParams,
  type RoomState, type ScenePlan, type StemRole,
} from "@hive/protocol";
import { ClockModel, localNow } from "./clock";
import { Emitter, persistedClientId, RoomTransport } from "./transport";
import type { CalibrationResult, ConnectionState, HiveClient, HiveClientOptions, SyncStatus } from "./index";

export function createStubClient(opts: HiveClientOptions): HiveClient {
  const clientId = opts.clientId ?? persistedClientId(opts.roomCode);
  const clock = new ClockModel(); // pairs: false — see the file header
  const ev = new Emitter();
  let room: RoomState | null = null;
  let audioState: AudioState = "locked";
  let loadProgress = 0;
  let muted = false;
  let timers: Array<ReturnType<typeof setInterval>> = [];
  let pairTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPositionSent = 0;
  let probeGroup = 0;

  const me = (): ClientRecord | null => room?.clients[clientId] ?? null;
  const status = (): SyncStatus => ({
    clockOffsetMs: clock.offsetMs,
    rttMs: clock.rttMs,
    syncErrMs: clock.rttMs == null ? null : clock.rttMs / 2,
    outputLatencyMs: null,
    compensationMs: me()?.assignment?.compensationMs ?? 0,
    lastCorrectionMs: 0,
    playheadErrorMs: 0,
    playing: room?.transport.state === "playing",
  });

  const transport = new RoomTransport(
    opts,
    clientId,
    {
      onWelcome: () => startTimers(),
      onConnection: (c) => ev.emit("connection", c),
      onReconnect: () => stopTimers(),
      onMessage: (m, at) => {
        switch (m.type) {
          case "NTP_RESPONSE":
            clock.addProbe(m.t0, m.t1, m.t2, at);
            ev.emit("status", status());
            break;
          case "ROOM_STATE": {
            const prev = JSON.stringify(me()?.assignment ?? null);
            room = m.room;
            ev.emit("state", room);
            const next = me()?.assignment ?? null;
            if (prev !== JSON.stringify(next)) ev.emit("assignment", next);
            break;
          }
          case "HEALTH":
            ev.emit("health", m.clients as Record<string, HealthSnapshot>, m.serverTime);
            break;
          case "PING":
            transport.send({ type: "PONG" });
            break;
          case "SCHEDULED_ACTION":
            if (m.action.kind === "CALIBRATION_CLICK") ev.emit("calibrationClick", m.serverTimeToExecute);
            break;
          case "ERROR":
            ev.emit("error", m.code, m.message);
            if (m.code === "KICKED") {
              transport.stopReconnecting();
              room = null;
            }
            break;
        }
      },
    },
    localNow,
  );

  function probe(): void {
    const id = probeGroup++;
    transport.send({ type: "NTP_REQUEST", t0: localNow(), probeGroupId: id, probeGroupIndex: 0 });
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = setTimeout(() => {
      pairTimer = null;
      transport.send({ type: "NTP_REQUEST", t0: localNow(), probeGroupId: id, probeGroupIndex: 1 });
    }, ClockModel.pairGapMs);
  }

  function startTimers(): void {
    stopTimers();
    let n = 0;
    const burst = setInterval(() => {
      probe();
      if (++n >= NTP_BURST_COUNT) clearInterval(burst);
    }, NTP_BURST_WINDOW_MS / NTP_BURST_COUNT);
    timers.push(burst, setInterval(probe, NTP_STEADY_INTERVAL_MS));
    timers.push(
      setInterval(() => {
        const s = status();
        transport.send({ type: "CLIENT_STATUS", rttMs: s.rttMs, syncErrMs: s.syncErrMs, outputLatencyMs: null, audioState });
      }, CLIENT_STATUS_INTERVAL_MS),
    );
    probe();
  }

  function stopTimers(): void {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = null;
  }

  const client: HiveClient = {
    clientId,
    get room() { return room; },
    get me() { return me(); },
    get assignment() { return me()?.assignment ?? null; },
    get connection(): ConnectionState { return transport.connection; },
    get status() { return status(); },
    clock: {
      serverNow: () => clock.serverNow(),
      trackTimeSec: () => (room ? transportTrackTimeSec(room.transport, clock.serverNow()) : 0),
      ctxTimeFor: (serverTime) => (serverTime - clock.serverNow()) / 1000, // stub: seconds from now
    },
    audio: {
      async unlock() {
        audioState = "unlocked";
        ev.emit("audio", audioState, 0);
        audioState = "loading";
        for (let i = 1; i <= 4; i++) {
          await new Promise((r) => setTimeout(r, 120));
          loadProgress = i / 4;
          ev.emit("audio", audioState, loadProgress);
        }
        audioState = "ready";
        ev.emit("audio", audioState, 1);
        if (room?.track) transport.send({ type: "AUDIO_READY", trackId: room.track.id });
      },
      get state() { return audioState; },
      get loadProgress() { return loadProgress; },
      setMuted(m) { muted = m; ev.emit("audio", audioState, loadProgress); },
      get muted() { return muted; },
      // The stub has no AudioContext at all, and says so rather than inventing plausible values.
      ctxState: null,
      sampleRate: null,
    },
    host: {
      setTrack: (trackId) => transport.send({ type: "SET_TRACK", trackId }),
      play: (trackTimeSec) => transport.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec }),
      pause: () => transport.send({ type: "TRANSPORT", action: "PAUSE" }),
      seek: (trackTimeSec) => transport.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec }),
      setMode: (mode: ModeKind, params: ModeParams = {}) => transport.send({ type: "SET_MODE", mode, params }),
      assign: (id: string, role: StemRole | null) => transport.send({ type: "ASSIGN", clientId: id, role }),
      setPosition: (id, x, y) => {
        const t = localNow();
        if (t - lastPositionSent < 1000 / SET_POSITION_MAX_HZ) return;
        lastPositionSent = t;
        transport.send({ type: "SET_POSITION", clientId: id, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
      },
      nudge: (id, nudgeMs) => transport.send({ type: "NUDGE", clientId: id, nudgeMs }),
      setPlays: (plays) => transport.send({ type: "SET_PLAYS", plays }),
      kick: (id) => transport.send({ type: "KICK", clientId: id }),
      async startCalibration() {
        transport.send({ type: "CALIBRATION_START", referenceClientId: clientId });
        await new Promise<void>((resolve) => {
          let sawRun = false;
          const off = ev.on("state", (r) => {
            const st = r.calibration.state;
            if (st === "countdown" || st === "running") sawRun = true;
            if (st === "done" || st === "failed" || (sawRun && st === "idle")) { off(); resolve(); }
          });
        });
      },
      cancelCalibration: () => transport.send({ type: "CALIBRATION_CANCEL" }),
      resetCalibration: (clientId?: string) =>
        transport.send(clientId ? { type: "CALIBRATION_RESET", clientId } : { type: "CALIBRATION_RESET" }),
      async vibe(prompt: string): Promise<ScenePlan> {
        const res = await fetch(`${opts.apiUrl}/rooms/${opts.roomCode}/vibe`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
        });
        if (!res.ok) throw new Error(`vibe failed: ${res.status}`);
        return ((await res.json()) as { scenePlan: ScenePlan }).scenePlan;
      },
    },
    calibration: {
      async runAsReference(): Promise<CalibrationResult> {
        throw new Error("stub client has no microphone; the real engine implements runAsReference (gate B8)");
      },
      renderClick: () => new Float32Array(0),
    },
    nudgeSelf: (nudgeMs) => transport.send({ type: "NUDGE", clientId, nudgeMs }),
    connect: () => transport.connect(),
    disconnect: () => {
      stopTimers();
      transport.disconnect();
    },
    on: (e, h) => ev.on(e, h),
    off: (e, h) => ev.off(e, h),
  };
  void (null as Assignment | null);
  return client;
}
