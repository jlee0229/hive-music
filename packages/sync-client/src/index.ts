/**
 * @hive/sync-client — the headless browser engine every HiveMusic phone runs.
 *
 * OWNER: backend agent (see agents/BACKEND-AGENT.md). The frontend agent CONSUMES this API and never
 * creates its own AudioContext or WebSocket. This file is the frozen public surface (IC0); the backend
 * agent fills in the implementation behind it without changing the shapes. Additive changes only, and
 * each one is announced in docs/PROTOCOL-REQUESTS.md.
 *
 * Algorithms: docs/03-sync-engine.md. Calibration: docs/04-calibration.md. Contract: docs/02-protocol.md.
 */
import type {
  Assignment, AudioState, BrowserFamily, ClickSpec, ClientRecord, DeviceInfo, HealthSnapshot, ModeKind, ModeParams,
  RoomState, ScenePlan, StemRole,
} from "@hive/protocol";

export type { Assignment, AudioState, ClientRecord, DeviceInfo, RoomState, ScenePlan, StemRole };

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface HiveClientOptions {
  /** e.g. wss://hivemusic-server.fly.dev/ws */
  wsUrl: string;
  /** e.g. https://hivemusic-server.fly.dev (REST: /tracks, /rooms, /audio, /vibe) */
  apiUrl: string;
  roomCode: string;
  kind: "host" | "player";
  /** Hosts: "use this phone as a speaker too". Players: always true. */
  plays: boolean;
  hostKey?: string;
  name?: string;
  /** Override the auto-generated, localStorage-persisted client id (tests). */
  clientId?: string;
}

export interface SyncStatus {
  /** serverTime − localTime, ms (min-RTT filtered). null until the first burst completes. */
  clockOffsetMs: number | null;
  /** Best (minimum) round-trip seen in the sliding window, ms. */
  rttMs: number | null;
  /** rtt/2 + |last applied correction|; what CLIENT_STATUS reports and what healthLevel() colors. */
  syncErrMs: number | null;
  /** AudioContext.outputLatency when the browser exposes it, else null. */
  outputLatencyMs: number | null;
  /** nudge + (calibrated ?? table ?? 0), as delivered in the current assignment. */
  compensationMs: number;
  /** Last hard resync applied to the playhead, ms (0 when none). */
  lastCorrectionMs: number;
  playing: boolean;
}

export interface CalibrationProgress {
  phase: "countdown" | "listening" | "analysing" | "done" | "failed";
  /** Which client's click is being listened for right now. */
  currentClientId: string | null;
  done: number;
  total: number;
}

export interface CalibrationMeasurement {
  clientId: string;
  /** How late this phone's click arrived relative to the schedule, ms (positive = late). */
  residualMs: number;
  /** 0..1 — matched-filter peak prominence; below 0.5 the server should ignore it. */
  confidence: number;
}

export interface CalibrationResult {
  measurements: CalibrationMeasurement[];
  /** Raw peak-picking diagnostics for evidence files (gate B8). */
  diagnostics: Record<string, unknown>;
}

export type HiveEvents = {
  /** Full room snapshot (≤2 Hz). Idempotent: render from it, never diff against previous events. */
  state: (room: RoomState) => void;
  /** Hosts only, 1 Hz. */
  health: (clients: Record<string, HealthSnapshot>, serverTime: number) => void;
  /** Sync numbers changed (after every probe). */
  status: (status: SyncStatus) => void;
  connection: (state: ConnectionState) => void;
  audio: (state: AudioState, loadProgress: number) => void;
  /** Own assignment changed (derived from `state`, emitted for convenience). */
  assignment: (assignment: Assignment | null) => void;
  /** Player screens flash on this; the click itself is scheduled by the engine. */
  calibrationClick: (clickAtServerTime: number) => void;
  error: (code: string, message: string) => void;
};

export interface HiveClock {
  /** Estimated current server time, ms epoch. Safe to call at 60 fps. */
  serverNow(): number;
  /** Current track position in seconds derived from room.transport (0 when stopped). */
  trackTimeSec(): number;
  /** AudioContext time at which a given server time will come out of this device's speaker. */
  ctxTimeFor(serverTime: number): number;
}

export interface HiveAudio {
  /** Must be called inside a user gesture: resumes the AudioContext, plays a silent buffer (iOS), sets audioSession.type='playback' when available, requests a wake lock. */
  unlock(): Promise<void>;
  readonly state: AudioState;
  /** 0..1 across all stems of the current track. */
  readonly loadProgress: number;
  /** Local mute (does not change the assignment). */
  setMuted(muted: boolean): void;
  readonly muted: boolean;
}

export interface HiveHostControls {
  setTrack(trackId: string): void;
  play(trackTimeSec?: number): void;
  pause(): void;
  seek(trackTimeSec: number): void;
  setMode(mode: ModeKind, params?: ModeParams): void;
  /** Pin (role) or unpin (null) a player's stem. */
  assign(clientId: string, role: StemRole | null): void;
  /** Throttled to SET_POSITION_MAX_HZ inside the engine. x,y ∈ [0,1]. */
  setPosition(clientId: string, x: number, y: number): void;
  nudge(clientId: string, nudgeMs: number): void;
  /** Hosts only: opt this phone in/out of being a speaker. */
  setPlays(plays: boolean): void;
  kick(clientId: string): void;
  /** Starts the tuning moment with this device as the listener; resolves when the server reports done/failed — or when a cancel returns the room to idle. */
  startCalibration(): Promise<void>;
  /**
   * Abandons a tuning moment in progress (`CALIBRATION_CANCEL`, host only). The room returns to
   * `idle`, no `calibratedOffsetMs` is written, every phone drops its pending clicks, and an
   * in-flight `calibration.runAsReference()` rejects with `CalibrationCancelledError` after
   * releasing the microphone. Safe to call when nothing is running.
   */
  cancelCalibration(): void;
  /**
   * Throws away measured offsets (`CALIBRATION_RESET`, host only): one client, or every client in the
   * room when `clientId` is omitted. The undo for a tuning moment that measured the wrong thing — a
   * phone in a pocket, a click matched to a sidelobe — and distinct from re-running calibration, because
   * a wrong `calibratedOffsetMs` is the accumulation base for the next run.
   *
   * Cleared to `null`, not `0`: the phone falls back to its Tier-1 table row, so a reset is never worse
   * than never having calibrated. **Cancel first if a run is in flight** — the server answers `ERROR`
   * `CALIBRATION_BUSY` while `calibration.state !== "idle"`, since clearing the base between the clicks
   * and the report would bake in the error you were removing.
   */
  resetCalibration(clientId?: string): void;
  /** POST /rooms/:code/vibe — resolves with the server's plan (LLM or rules fallback). */
  vibe(prompt: string): Promise<ScenePlan>;
}

export interface HiveCalibration {
  /**
   * Runs on the reference device (the host phone). Opens the mic with echoCancellation/AGC/noiseSuppression off,
   * records through the CALIBRATION_PLAN window, cross-correlates each expected click, reports CALIBRATION_REPORT,
   * then releases the mic (track.stop()). Rejects if getUserMedia is denied.
   */
  runAsReference(opts?: { onProgress?: (p: CalibrationProgress) => void }): Promise<CalibrationResult>;
  /** The click waveform the engine will play for a given spec (exposed for the measurement rig and tests). */
  renderClick(spec: ClickSpec, sampleRate: number): Float32Array;
}

export interface HiveClient {
  readonly clientId: string;
  readonly room: RoomState | null;
  /** This client's own record inside `room`, or null before WELCOME. */
  readonly me: ClientRecord | null;
  readonly assignment: Assignment | null;
  readonly connection: ConnectionState;
  readonly status: SyncStatus;
  readonly clock: HiveClock;
  readonly audio: HiveAudio;
  readonly host: HiveHostControls;
  readonly calibration: HiveCalibration;
  /** Nudge this phone (players may nudge themselves; hosts nudge anyone via host.nudge). */
  nudgeSelf(nudgeMs: number): void;
  connect(): Promise<void>;
  disconnect(): void;
  on<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): () => void;
  off<K extends keyof HiveEvents>(event: K, handler: HiveEvents[K]): void;
}

/** Best-effort browser family + model from the user agent (used for JOIN.device and the Tier-1 table). */
export function detectDevice(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): DeviceInfo {
  const ua = userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1);
  const isAndroid = /Android/.test(ua);
  const isChrome = /Chrome\/|CriOS\//.test(ua) && !/Edg\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !isChrome && !/Chromium|Android/.test(ua);
  let browserFamily: BrowserFamily = "other";
  if (isIOS) browserFamily = "ios-safari"; // every iOS browser is WebKit; Chrome-on-iOS behaves like Safari for audio
  else if (isAndroid && isChrome) browserFamily = "android-chrome";
  else if (isChrome) browserFamily = "desktop-chrome";
  else if (isSafari) browserFamily = "desktop-safari";
  const platform = isIOS ? "ios" : isAndroid ? "android" : /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "windows" : /Linux/.test(ua) ? "linux" : "unknown";
  const model = ua.match(/\(([^;)]+)/)?.[1]?.slice(0, 64);
  return { userAgent: ua.slice(0, 512), platform, browserFamily, model };
}

/**
 * Creates the engine. Transport + clock are live (gate B2); the audio graph arrives with gate B3 and
 * until then `audio.unlock()` throws rather than reporting a readiness it cannot deliver. For UI work
 * against the mock server, keep using `createStubClient`, which speaks the full protocol with no audio.
 */
export { createHiveClient } from "./client";
export type { AudioEngine, AudioEngineContext, CreateHiveClientInternals } from "./client";

export { createStubClient } from "./stub";
/** The clock model and the serverTime↔AudioContext mapping (exported for the rig, /diag and tests). */
export { ClockModel, CtxMapper, SLEW_RATE_MS_PER_SEC, localNow } from "./clock";
export { reconnectDelayMs } from "./transport";
export { CalibrationCancelledError } from "./calibration/reference";
