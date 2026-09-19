/**
 * createStubClient — a HiveClient with REAL protocol plumbing and NO audio.
 * Speaks the full WebSocket contract (JOIN, NTP probes with min-RTT selection, ROOM_STATE, HEALTH, PING/PONG,
 * host controls, CLIENT_STATUS) so the frontend can build every screen against the mock server, and Playwright
 * tests stay deterministic. `audio.unlock()` fakes a download and reports "ready"; nothing is ever played.
 *
 * Backend agent: reuse the transport/NTP parts in the real engine; keep this stub working (Playwright depends on it).
 */
import {
  CLIENT_STATUS_INTERVAL_MS, NTP_BURST_COUNT, NTP_BURST_WINDOW_MS, NTP_STEADY_INTERVAL_MS, NTP_WINDOW, PROTOCOL_VERSION,
  SET_POSITION_MAX_HZ, parseServerMessage, trackTimeSec as transportTrackTimeSec,
  type Assignment, type AudioState, type ClientMessage, type ClientRecord, type ModeKind, type ModeParams, type RoomState,
  type ScenePlan, type StemRole, type HealthSnapshot,
} from "@hive/protocol";
import { detectDevice, type CalibrationResult, type ConnectionState, type HiveClient, type HiveClientOptions, type HiveEvents, type SyncStatus } from "./index";

const localNow = () => (typeof performance !== "undefined" ? performance.timeOrigin + performance.now() : Date.now());

function persistedClientId(roomCode: string): string {
  const key = `hive:clientId:${roomCode}`;
  try {
    const existing = globalThis.localStorage?.getItem(key);
    if (existing) return existing;
    const id = globalThis.crypto?.randomUUID?.() ?? `c-${Math.random().toString(36).slice(2, 14)}`;
    globalThis.localStorage?.setItem(key, id);
    return id;
  } catch {
    return globalThis.crypto?.randomUUID?.() ?? `c-${Math.random().toString(36).slice(2, 14)}`;
  }
}

/** Min-RTT clock model shared by the stub and (to be) the real engine. */
export class ClockModel {
  private samples: Array<{ offset: number; rtt: number }> = [];
  offsetMs: number | null = null;
  rttMs: number | null = null;
  addProbe(t0: number, t1: number, t2: number, t3: number): void {
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    const rtt = t3 - t0 - (t2 - t1);
    this.samples.push({ offset, rtt });
    if (this.samples.length > NTP_WINDOW) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offsetMs = best.offset;
    this.rttMs = best.rtt;
  }
  serverNow(): number {
    return localNow() + (this.offsetMs ?? 0);
  }
}

class Emitter {
  private handlers = new Map<string, Set<(...a: never[]) => void>>();
  on<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as (...a: never[]) => void);
    return () => this.off(event, handler);
  }
  off<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): void {
    this.handlers.get(event)?.delete(handler as (...a: never[]) => void);
  }
  emit<K extends keyof HiveEvents>(event: K, ...args: Parameters<HiveEvents[K]>): void {
    for (const h of this.handlers.get(event) ?? []) (h as unknown as (...a: Parameters<HiveEvents[K]>) => void)(...args);
  }
}

export function createStubClient(opts: HiveClientOptions): HiveClient {
  const clientId = opts.clientId ?? persistedClientId(opts.roomCode);
  const clock = new ClockModel();
  const ev = new Emitter();
  let ws: WebSocket | null = null;
  let room: RoomState | null = null;
  let connection: ConnectionState = "closed";
  let audioState: AudioState = "locked";
  let loadProgress = 0;
  let muted = false;
  let reconnectAttempt = 0;
  let timers: ReturnType<typeof setInterval>[] = [];
  let closedByUser = false;
  let lastPositionSent = 0;
  let probeGroup = 0;

  const status = (): SyncStatus => ({
    clockOffsetMs: clock.offsetMs,
    rttMs: clock.rttMs,
    syncErrMs: clock.rttMs == null ? null : clock.rttMs / 2,
    outputLatencyMs: null,
    compensationMs: me()?.assignment?.compensationMs ?? 0,
    lastCorrectionMs: 0,
    playing: room?.transport.state === "playing",
  });
  const me = (): ClientRecord | null => room?.clients[clientId] ?? null;
  const send = (m: ClientMessage) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  };
  const setConnection = (c: ConnectionState) => {
    if (connection === c) return;
    connection = c;
    ev.emit("connection", c);
  };

  function probe() {
    const id = probeGroup++;
    send({ type: "NTP_REQUEST", t0: localNow(), probeGroupId: id, probeGroupIndex: 0 });
    setTimeout(() => send({ type: "NTP_REQUEST", t0: localNow(), probeGroupId: id, probeGroupIndex: 1 }), 10);
  }

  function startTimers() {
    stopTimers();
    // burst, then steady
    let n = 0;
    const burst = setInterval(() => {
      probe();
      if (++n >= NTP_BURST_COUNT) clearInterval(burst);
    }, NTP_BURST_WINDOW_MS / NTP_BURST_COUNT);
    timers.push(burst);
    timers.push(setInterval(probe, NTP_STEADY_INTERVAL_MS));
    timers.push(
      setInterval(() => {
        const s = status();
        send({ type: "CLIENT_STATUS", rttMs: s.rttMs, syncErrMs: s.syncErrMs, outputLatencyMs: null, audioState });
      }, CLIENT_STATUS_INTERVAL_MS),
    );
  }
  function stopTimers() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  function open(): Promise<void> {
    return new Promise((resolve, reject) => {
      setConnection(reconnectAttempt === 0 ? "connecting" : "reconnecting");
      const sock = new WebSocket(opts.wsUrl);
      ws = sock;
      let welcomed = false;
      sock.onopen = () => {
        send({
          type: "JOIN", clientId, roomCode: opts.roomCode, kind: opts.kind, plays: opts.kind === "player" ? true : opts.plays,
          hostKey: opts.hostKey, name: opts.name, device: detectDevice(), protocolVersion: PROTOCOL_VERSION,
        });
      };
      sock.onmessage = (e) => {
        const m = parseServerMessage(String(e.data));
        if (!m) return;
        switch (m.type) {
          case "WELCOME":
            welcomed = true;
            reconnectAttempt = 0;
            setConnection("open");
            startTimers();
            resolve();
            break;
          case "NTP_RESPONSE":
            clock.addProbe(m.t0, m.t1, m.t2, localNow());
            ev.emit("status", status());
            break;
          case "ROOM_STATE": {
            const prev = me()?.assignment ?? null;
            room = m.room;
            ev.emit("state", room);
            const next = me()?.assignment ?? null;
            if (JSON.stringify(prev) !== JSON.stringify(next)) ev.emit("assignment", next);
            break;
          }
          case "HEALTH":
            ev.emit("health", m.clients as Record<string, HealthSnapshot>, m.serverTime);
            break;
          case "PING":
            send({ type: "PONG" });
            break;
          case "SCHEDULED_ACTION":
            if (m.action.kind === "CALIBRATION_CLICK") ev.emit("calibrationClick", m.serverTimeToExecute);
            break;
          case "ERROR":
            ev.emit("error", m.code, m.message);
            if (m.code === "KICKED") { closedByUser = true; room = null; }
            if (!welcomed) reject(new Error(`${m.code}: ${m.message}`));
            break;
        }
      };
      sock.onclose = () => {
        stopTimers();
        if (closedByUser) return setConnection("closed");
        reconnectAttempt++;
        setConnection("reconnecting");
        setTimeout(() => open().catch(() => {}), Math.min(5000, 300 * 2 ** Math.min(reconnectAttempt, 4)));
      };
      sock.onerror = () => { /* onclose follows */ };
    });
  }

  const client: HiveClient = {
    clientId,
    get room() { return room; },
    get me() { return me(); },
    get assignment() { return me()?.assignment ?? null; },
    get connection() { return connection; },
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
        if (room?.track) send({ type: "AUDIO_READY", trackId: room.track.id });
      },
      get state() { return audioState; },
      get loadProgress() { return loadProgress; },
      setMuted(m) { muted = m; },
      get muted() { return muted; },
    },
    host: {
      setTrack: (trackId) => send({ type: "SET_TRACK", trackId }),
      play: (trackTimeSec) => send({ type: "TRANSPORT", action: "PLAY", trackTimeSec }),
      pause: () => send({ type: "TRANSPORT", action: "PAUSE" }),
      seek: (trackTimeSec) => send({ type: "TRANSPORT", action: "SEEK", trackTimeSec }),
      setMode: (mode: ModeKind, params: ModeParams = {}) => send({ type: "SET_MODE", mode, params }),
      assign: (id: string, role: StemRole | null) => send({ type: "ASSIGN", clientId: id, role }),
      setPosition: (id, x, y) => {
        const t = localNow();
        if (t - lastPositionSent < 1000 / SET_POSITION_MAX_HZ) return;
        lastPositionSent = t;
        send({ type: "SET_POSITION", clientId: id, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
      },
      nudge: (id, nudgeMs) => send({ type: "NUDGE", clientId: id, nudgeMs }),
      setPlays: (plays) => send({ type: "SET_PLAYS", plays }),
      kick: (id) => send({ type: "KICK", clientId: id }),
      async startCalibration() {
        send({ type: "CALIBRATION_START", referenceClientId: clientId });
        await new Promise<void>((resolve) => {
          const off = ev.on("state", (r) => {
            if (r.calibration.state === "done" || r.calibration.state === "failed") { off(); resolve(); }
          });
        });
      },
      async vibe(prompt: string): Promise<ScenePlan> {
        const res = await fetch(`${opts.apiUrl}/rooms/${opts.roomCode}/vibe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
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
    nudgeSelf: (nudgeMs) => send({ type: "NUDGE", clientId, nudgeMs }),
    connect: () => { closedByUser = false; return open(); },
    disconnect: () => { closedByUser = true; stopTimers(); ws?.close(); setConnection("closed"); },
    on: (e, h) => ev.on(e, h),
    off: (e, h) => ev.off(e, h),
  };
  void (null as Assignment | null);
  return client;
}
