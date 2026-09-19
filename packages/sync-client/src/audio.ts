/**
 * The audio engine: one AudioContext, the iOS unlock dance, stem loading, and the glue that keeps the
 * scheduler pointed at the current transport.
 *
 * Most of this file is about a phone being a hostile place to play synchronised audio:
 *  - WebKit will not start a context outside a user gesture, and everything in `unlock()` before the
 *    first `await` has to run inside the tap handler.
 *  - iOS mutes Web Audio with the silent switch unless `navigator.audioSession.type = 'playback'`.
 *  - a lock screen, a phone call or a backgrounded tab moves the context to 'interrupted'/'suspended',
 *    and coming back is a *resync*, not a resume: the timeline moved on without us.
 *  - stems are WAV, not MP3, because `decodeAudioData` on MP3 inserts a decoder delay that differs by
 *    browser by up to ~25 ms — which is the entire error budget.
 */
import {
  DEFAULT_CLICK_SPEC, type Assignment, type AudioState, type ClickSpec, type RoomState,
} from "@hive/protocol";
import type { AudioEngine, AudioEngineContext } from "./client";
import { renderClick } from "./calibration/click";
import { Scheduler, type BufferLike, type CtxLike } from "./scheduler";
import type { CalibrationProgress, CalibrationResult, HiveCalibration } from "./index";

/** Re-checked on visibility changes; a screen that sleeps stops the audio on some Android builds. */
type WakeLockSentinelLike = { released: boolean; release(): Promise<void> };

/**
 * Two APIs the DOM types do not agree with us about: `navigator.audioSession` is Safari 17+ only and
 * absent from lib.dom, and `navigator.wakeLock` is optional in practice even where it is typed.
 */
type AudioSessionNavigator = Omit<Navigator, "wakeLock"> & {
  audioSession?: { type: string };
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
};

export interface BrowserAudioEngineOptions {
  /** Injected in tests; defaults to the real AudioContext. */
  createContext?: () => AudioContext;
  /** Injected in tests; defaults to fetch + decodeAudioData. */
  loadStem?: (url: string, ctx: AudioContext) => Promise<AudioBuffer>;
}

export function createBrowserAudioEngine(
  host: AudioEngineContext,
  opts: BrowserAudioEngineOptions = {},
): AudioEngine {
  const { clock, mapper, emit, send, opts: clientOpts } = host;

  let ctx: AudioContext | null = null;
  let scheduler: Scheduler | null = null;
  let state: AudioState = "locked";
  let loadProgress = 0;
  let muted = false;
  let loadedTrackId: string | null = null;
  let loadingTrackId: string | null = null;
  let wakeLock: WakeLockSentinelLike | null = null;
  let outputLatencyMs: number | null = null;
  let lastRoom: RoomState | null = null;
  let lastAssignment: Assignment | null = null;
  let listenersBound = false;

  const setState = (next: AudioState): void => {
    if (state === next) return;
    state = next;
    emit.emit("audio", state, loadProgress);
  };

  const makeContext = (): AudioContext =>
    opts.createContext
      ? opts.createContext()
      : new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({
          latencyHint: "interactive",
        });

  /** Whether the client must subtract `ctx.outputLatency` itself (only when the server knows nothing). */
  const useOutputLatency = (): boolean => {
    const me = lastRoom?.clients[host.clientId];
    return !me || (me.tableLatencyMs == null && me.calibratedOffsetMs == null);
  };

  async function requestWakeLock(): Promise<void> {
    const nav = navigator as unknown as AudioSessionNavigator;
    if (!nav.wakeLock) return;
    try {
      wakeLock = await nav.wakeLock.request("screen");
    } catch {
      /* not fatal: HTTPS-only, and refused when the tab is hidden */
    }
  }

  function bindLifecycle(): void {
    if (listenersBound || typeof document === "undefined") return;
    listenersBound = true;

    // A resumed tab, a resumed context: the timeline moved on while we were away, so reschedule from
    // the transport rather than trusting the sources that were left running.
    const resync = (reason: string): void => {
      if (!ctx || !lastRoom) return;
      if (ctx.state === "running") {
        setState(loadedTrackId ? "ready" : state === "locked" ? "unlocked" : state);
        reschedule(true, reason);
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      void requestWakeLock();
      if (ctx && ctx.state !== "running") {
        // Outside a gesture this is allowed to fail; the UI shows "tap to resume".
        ctx.resume().then(() => resync("visible")).catch(() => setState("locked"));
      } else {
        resync("visible");
      }
    });
  }

  function bindContextState(current: AudioContext): void {
    current.onstatechange = () => {
      // 'interrupted' is iOS-only and not in the TS union.
      const s = current.state as AudioContextState | "interrupted";
      if (s === "running") {
        if (loadedTrackId) setState("ready");
        reschedule(true, "context running");
      } else if (s === "suspended" || s === "interrupted") {
        // Buffers are kept: the next unlock() returns straight to ready.
        setState("locked");
      }
    };
  }

  /** Recomputes the schedule from the latest snapshot. Safe to call as often as you like. */
  function reschedule(force: boolean, _reason: string): void {
    if (!scheduler || !lastRoom) return;
    scheduler.apply(lastRoom.transport, lastAssignment, {
      trackId: lastRoom.track?.id ?? null,
      useOutputLatency: useOutputLatency(),
      force,
    });
  }

  async function loadTrack(room: RoomState): Promise<void> {
    const track = room.track;
    if (!ctx || !track || loadingTrackId === track.id || loadedTrackId === track.id) return;
    loadingTrackId = track.id;
    loadProgress = 0;
    setState("loading");
    emit.emit("audio", state, loadProgress);

    const context = ctx;
    const done = new Array(track.stems.length).fill(0) as number[];
    const total = track.stems.length;
    try {
      const buffers = await Promise.all(
        track.stems.map(async (stem, i) => {
          const url = `${clientOpts.apiUrl}/audio/${track.id}/${stem}.wav`;
          const buffer = opts.loadStem
            ? await opts.loadStem(url, context)
            : await defaultLoadStem(url, context, (fraction) => {
                done[i] = fraction;
                // Decode is the last 5 %: a stem that has arrived is not yet a stem you can play.
                loadProgress = (done.reduce((a, b) => a + b, 0) / total) * 0.95;
                emit.emit("audio", state, loadProgress);
              });
          done[i] = 1;
          return [stem, buffer] as const;
        }),
      );
      if (loadingTrackId !== track.id) return; // SET_TRACK landed again while we were decoding
      const map = new Map<string, BufferLike>(buffers);
      scheduler?.setBuffers(map, track.id);
      loadedTrackId = track.id;
      loadProgress = 1;
      setState("ready");
      emit.emit("audio", state, loadProgress);
      // AUDIO_READY means *every* stem is decoded, never "the first one is playable".
      send({ type: "AUDIO_READY", trackId: track.id });
      reschedule(true, "track loaded");
    } catch (err) {
      emit.emit("error", "AUDIO_LOAD_FAILED", err instanceof Error ? err.message : String(err));
      setState("unlocked");
    } finally {
      if (loadingTrackId === track.id) loadingTrackId = null;
    }
  }

  const calibration: HiveCalibration = {
    async runAsReference(_o?: { onProgress?: (p: CalibrationProgress) => void }): Promise<CalibrationResult> {
      throw new Error("@hive/sync-client: runAsReference lands in gate B8e");
    },
    renderClick: (spec: ClickSpec, sampleRate: number) => renderClick(spec, sampleRate),
  };

  const engine: AudioEngine = {
    /**
     * Must be called from inside a tap. Everything WebKit cares about happens before the first await.
     */
    async unlock(): Promise<void> {
      if (!ctx) {
        ctx = makeContext();
        bindContextState(ctx);
        scheduler = new Scheduler({ ctx: ctx as unknown as CtxLike, clock, mapper, now: host.now });
        scheduler.setMuted(muted);
      }
      const nav = navigator as unknown as AudioSessionNavigator;
      // Without this, the iOS silent switch mutes Web Audio and the phone looks broken but healthy.
      if (nav.audioSession) {
        try {
          nav.audioSession.type = "playback";
        } catch {
          /* feature-detected, not guaranteed writable */
        }
      }
      // A one-sample silent buffer satisfies WebKit's "you played something in a gesture" rule.
      try {
        const silent = ctx.createBufferSource();
        silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        silent.connect(ctx.destination);
        silent.start(0);
      } catch {
        /* older engines: resume() alone is enough */
      }
      await ctx.resume();
      outputLatencyMs = typeof ctx.outputLatency === "number" && ctx.outputLatency > 0 ? ctx.outputLatency * 1000 : null;
      bindLifecycle();
      void requestWakeLock();

      if (loadedTrackId) {
        setState("ready");
        reschedule(true, "unlock with buffers already decoded");
        return;
      }
      setState("unlocked");
      if (lastRoom?.track) await loadTrack(lastRoom);
    },

    get state() {
      return state;
    },
    get loadProgress() {
      return loadProgress;
    },
    setMuted(next: boolean) {
      muted = next;
      scheduler?.setMuted(next);
    },
    get muted() {
      return muted;
    },

    ctxNow: () => (ctx && ctx.state !== "closed" ? ctx.currentTime : null),

    applyRoom(room: RoomState, assignment: Assignment | null): void {
      lastRoom = room;
      lastAssignment = assignment;
      if (!ctx) return; // still locked: nothing to schedule, the snapshot is remembered
      if (room.track && room.track.id !== loadedTrackId && state !== "loading") {
        if (loadedTrackId && room.track.id !== loadedTrackId) {
          loadedTrackId = null; // SET_TRACK to something else: drop the old buffers' claim
          scheduler?.stopAll("track changed");
        }
        void loadTrack(room);
        return;
      }
      reschedule(false, "room state");
    },

    get lastCorrectionMs() {
      return scheduler?.lastCorrectionMs ?? 0;
    },
    get outputLatencyMs() {
      return outputLatencyMs;
    },

    /**
     * The calibration click: scheduled on its own gain node, outside the pattern chain, with the same
     * compensation as music but no `delayMs` (docs/04 step 6) — WAVE's spatial delay must not move the
     * thing we are using to measure latency.
     */
    scheduleClick(serverTimeToExecute: number, spec: ClickSpec = DEFAULT_CLICK_SPEC): void {
      if (!ctx || ctx.state !== "running") return;
      const samples = renderClick(spec, ctx.sampleRate);
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = spec.gain;
      source.connect(gain);
      gain.connect(ctx.destination);

      const ctxNow = ctx.currentTime;
      const comp = (lastAssignment?.compensationMs ?? 0) / 1000;
      const ol = useOutputLatency() ? ctx.outputLatency || 0 : 0;
      const at = mapper.ctxTimeForNow(serverTimeToExecute, ctxNow, host.now()) - comp - ol;
      source.start(Math.max(ctxNow, at));
    },

    calibration,

    get debug() {
      return {
        startCtxForZero: scheduler?.startCtxForZero ?? null,
        lastDecision: scheduler?.lastDecision ?? null,
        playing: scheduler?.playing ?? false,
        ctxState: ctx ? (ctx.state as string) : null,
        loadedTrackId,
      };
    },

    dispose(): void {
      scheduler?.dispose();
      scheduler = null;
      if (wakeLock && !wakeLock.released) void wakeLock.release().catch(() => {});
      wakeLock = null;
      if (ctx) {
        ctx.onstatechange = null;
        void ctx.close().catch(() => {});
      }
      ctx = null;
      state = "locked";
    },
  };

  return engine;
}

/** fetch + decodeAudioData with byte progress from Content-Length when the server sends it. */
async function defaultLoadStem(
  url: string,
  ctx: AudioContext,
  onProgress: (fraction: number) => void,
): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stem ${url} failed: ${res.status}`);
  const totalBytes = Number(res.headers.get("content-length") ?? 0);
  let bytes = new Uint8Array(0);
  if (res.body && totalBytes > 0) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(1, received / totalBytes));
    }
    bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(1);
  }
  // decodeAudioData detaches the buffer, so hand it a copy we no longer need.
  return ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
}
