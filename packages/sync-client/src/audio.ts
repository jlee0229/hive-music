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
  DEFAULT_CLICK_SPEC, ROOM_STATE_MAX_HZ,
  type Assignment, type AudioState, type ClickSpec, type RoomState,
} from "@hive/protocol";

/**
 * Minimum gap between AUDIO_READY announcements: one `ROOM_STATE` period, the time it takes for a
 * message we just sent to appear in a snapshot. Anything shorter would re-announce while our own
 * message is still in flight.
 */
const READY_REANNOUNCE_MIN_MS = 1000 / ROOM_STATE_MAX_HZ;

/** Web Audio's render quantum, frames. The granularity of every `start(when)` we make. */
const RENDER_QUANTUM = 128;

/** Silence watchdog: how often it looks, and the least real time a "the audio clock stood still" verdict needs. */
const WATCHDOG_INTERVAL_MS = 2000;
const WATCHDOG_MIN_WALL_MS = 1000;

/** Stem-load retry backoff: doubling from this, capped, so a 404 fixture cannot be re-fetched at 2 Hz. */
const LOAD_RETRY_BASE_MS = 1000;
const LOAD_RETRY_MAX_MS = 30_000;
import type { AudioEngine, AudioEngineContext } from "./client";
import { renderClick } from "./calibration/click";
import { pitchShiftMono } from "./pitch";
import { CalibrationCancelledError, runAsReference, type CalibrationPlan } from "./calibration/reference";
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
  /**
   * CHOIR (docs/05): the as-decoded stems, plus rendered pitch variants keyed `${trackId}:${semi}`.
   * The cache is cleared on every track change — one pitched copy of a 3-minute mono track is
   * ~35 MB of Float32, so only the current track's variants are worth keeping on a phone.
   */
  let originalBuffers: Map<string, BufferLike> | null = null;
  let appliedPitchSemitones = 0;
  const pitchedCache = new Map<string, Map<string, BufferLike>>();
  let pitchJobKey: string | null = null;
  /*
   * Read live, never cached. `ctx.outputLatency` is not a constant of the device: on iOS it changes when
   * the audio session does — a calibration run switches to play-and-record, a Bluetooth speaker or a
   * headset adds its own buffering — and the value is reported in CLIENT_STATUS, where the server uses it
   * as the accumulation base for a calibration report (P0-6). A cached number means a phone that gained
   * 170 ms of Bluetooth latency calibrates onto the latency it had at unlock, and the offset it is given
   * is wrong by the difference. The scheduler already reads the live value, so this only fixes what we
   * *say*.
   */
  const readOutputLatencyMs = (): number | null => {
    const ol = ctx?.outputLatency;
    return typeof ol === "number" && ol > 0 ? ol * 1000 : null;
  };
  let lastRoom: RoomState | null = null;
  let lastAssignment: Assignment | null = null;
  let listenersBound = false;
  let pendingPlan: CalibrationPlan | null = null;
  let planWaiter: ((plan: CalibrationPlan) => void) | null = null;
  /** Rejects the pending awaitPlan so a cancel does not wait out PLAN_TIMEOUT_MS with the mic open. */
  let planRejecter: ((err: Error) => void) | null = null;
  /** Clicks handed to us by SCHEDULED_ACTION that have not sounded yet, so a cancel can silence them. */
  let pendingClicks: Array<{ source: AudioBufferSourceNode; gain: GainNode; atCtx: number }> = [];
  /** Set while a run is live; flipped by a cancel so runAsReference aborts at its next await. */
  let cancelState: { cancelled: boolean } | null = null;
  let sawCalibrationRun = false;
  /** Set when a schedule was refused for want of a clock; the next accepted probe retries it. */
  let waitingForClock = false;
  /** `performance.now()` of the last AUDIO_READY we sent, so a re-announce cannot become a loop. */
  let lastReadyAnnounceAt = -Infinity;
  /** Calibration clicks dropped because their instant had already passed (diagnostics). */
  let clicksSkipped = 0;
  /**
   * Silence watchdog (the "connected but silent" phone): iOS can leave a context claiming
   * 'running' with a frozen audio clock and never fire statechange, and a missed suspend event
   * leaves the UI on the playing screen while nothing sounds. The watchdog detects both and routes
   * them through the existing Tap-to-resume recovery; a zombie context is rebuilt on that tap.
   */
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogLastCtxTime = -1;
  /** `performance.now()` beside `watchdogLastCtxTime`: a stall is only a stall across real elapsed time. */
  let watchdogLastWallMs = -1;
  let watchdogStalledTicks = 0;
  let zombieSuspected = false;
  /** Set by dispose(): async work that finishes afterwards (a download, a wake-lock grant) must not revive the engine. */
  let disposed = false;
  let onVisibilityChange: (() => void) | null = null;
  /**
   * Per-track load failures, for backoff. A failed load is retried — a phone that gives up on the first
   * flaky download is a phone that is silent for the whole set — but not on every snapshot: `ROOM_STATE`
   * arrives at 2 Hz, so an unconditional retry means 12 phones × 2 Hz × 4 stems ≈ 96 requests a second
   * against a server that is already failing (a missing fixture answers 404 just as fast as it can).
   * That is a thundering herd on the one code path where the server is least able to take it.
   */
  const loadFailures = new Map<string, { attempts: number; atMs: number }>();
  /**
   * The retry for a failed load. It cannot be left to "the next snapshot": the server publishes
   * ROOM_STATE only when something changes, so in a settled room the next snapshot may be a whole song
   * away — and a phone whose download failed once would sit silent until then.
   */
  let loadRetryTimer: ReturnType<typeof setTimeout> | null = null;

  /*
   * The clock arrives asynchronously, so the refused schedule has to be retried by an event rather than
   * polled. `status` fires after every probe, which is exactly when offsetMs can first become non-null.
   */
  emit.on("status", () => {
    if (!waitingForClock || clock.offsetMs === null) return;
    waitingForClock = false;
    reschedule(true, "clock ready");
  });

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
    if (!nav.wakeLock || disposed) return;
    // One sentinel at a time: every extra one is a lock dispose() cannot release, i.e. a screen that
    // never sleeps again after the party.
    if (wakeLock && !wakeLock.released) return;
    try {
      const sentinel = await nav.wakeLock.request("screen");
      if (disposed || (wakeLock && !wakeLock.released)) {
        void sentinel.release().catch(() => {});
        return;
      }
      wakeLock = sentinel;
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

    onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void requestWakeLock();
      if (ctx && ctx.state !== "running") {
        // Outside a gesture this is allowed to fail; the UI shows "tap to resume".
        ctx.resume().then(() => resync("visible")).catch(() => setState("locked"));
      } else {
        resync("visible");
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  /** Creates the AudioContext and the scheduler on first use. Safe to call inside a gesture. */
  function ensureContext(): AudioContext {
    if (!ctx) {
      ctx = makeContext();
      bindContextState(ctx);
      scheduler = new Scheduler({ ctx: ctx as unknown as CtxLike, clock, mapper, now: host.now });
      scheduler.setMuted(muted);
      startWatchdog();
    }
    return ctx;
  }

  function resetWatchdogBaseline(): void {
    watchdogLastCtxTime = -1;
    watchdogLastWallMs = -1;
    watchdogStalledTicks = 0;
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!ctx || !scheduler) return;
      const s = ctx.state as AudioContextState | "interrupted";
      if (s === "suspended" || s === "interrupted") {
        // A missed statechange event: the UI must fall back to Tap to resume, not play-screen silence.
        resetWatchdogBaseline();
        if (state === "ready" || state === "unlocked") setState("locked");
        return;
      }
      if (s !== "running") {
        resetWatchdogBaseline();
        return;
      }
      // Zombie detection: 'running' but the audio clock is frozen (iOS after interruptions/route
      // changes). One free resume() attempt; still frozen a tick later → Tap to resume, and that
      // tap rebuilds the context because resume() provably does nothing here.
      const t = ctx.currentTime;
      const wallMs = performance.now();
      /*
       * Judged only across real elapsed time. Timer callbacks bunch up — a main thread held by a decode
       * or a CHOIR render delivers a late tick and the next one right behind it — and two ticks 50 ms
       * apart see "no progress" on a perfectly healthy context. Two of those in a row put "Tap to
       * resume" on a phone that was playing fine.
       */
      const judged = watchdogLastCtxTime >= 0 && wallMs - watchdogLastWallMs >= WATCHDOG_MIN_WALL_MS;
      if (judged && t - watchdogLastCtxTime < 0.1) {
        watchdogStalledTicks++;
        if (watchdogStalledTicks === 1) void ctx.resume().catch(() => {});
        if (watchdogStalledTicks >= 2) {
          zombieSuspected = true;
          watchdogStalledTicks = 0;
          setState("locked");
        }
      } else if (judged) {
        watchdogStalledTicks = 0;
        if (zombieSuspected) {
          // The clock is moving again (the free resume() worked late, or iOS let go): this context is
          // not a zombie after all. Leaving the flag set would tear a healthy context down on the next
          // tap, and leaving the state "locked" would keep "Tap to resume" over audible music.
          zombieSuspected = false;
          if (state === "locked") {
            setState(loadedTrackId ? "ready" : "unlocked");
            reschedule(true, "watchdog: the audio clock is moving again");
          }
        }
      }
      if (judged || watchdogLastCtxTime < 0) {
        watchdogLastCtxTime = t;
        watchdogLastWallMs = wallMs;
      }
      // Self-heal: the room is playing, this phone is ready, the context runs — but nothing is
      // scheduled. Whatever dropped the branches (a swallowed error, a missed snapshot), rebuild.
      const shouldPlay = lastRoom?.transport.state === "playing" && !!loadedTrackId && lastRoom.track?.id === loadedTrackId;
      if (shouldPlay && state === "ready" && !scheduler.playing && clock.offsetMs !== null) {
        reschedule(true, "watchdog: silent while the transport is playing");
      }
    }, WATCHDOG_INTERVAL_MS);
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

  /**
   * Recomputes the schedule from the latest snapshot. Safe to call as often as you like.
   *
   * Refuses to schedule before the clock has accepted its first sample. `ClockModel.serverNow()` falls
   * back to `offsetMs ?? 0`, so scheduling early maps server time to ctx time using the raw difference
   * between two unrelated clocks — on a hotspot where stems decode before the first coded pair validates,
   * the first start can be seconds out, and it stays wrong until the 1 Hz drift check hauls it back. One
   * accepted sample is enough (the degraded-pair fallback guarantees one arrives), so this waits rather
   * than guessing.
   */
  function reschedule(force: boolean, _reason: string): void {
    if (!scheduler || !lastRoom) return;
    if (clock.offsetMs === null) {
      waitingForClock = true;
      return;
    }
    scheduler.apply(lastRoom.transport, lastAssignment, {
      trackId: lastRoom.track?.id ?? null,
      useOutputLatency: useOutputLatency(),
      force,
    });
  }

  const loadBackoffMs = (attempts: number): number =>
    Math.min(LOAD_RETRY_MAX_MS, LOAD_RETRY_BASE_MS * 2 ** (attempts - 1));

  /** True while a previously failed track is still inside its backoff window. */
  function loadBackoffHolds(trackId: string): boolean {
    const failure = loadFailures.get(trackId);
    if (!failure) return false;
    return performance.now() - failure.atMs < loadBackoffMs(failure.attempts);
  }

  /** Arms the one retry timer for the end of `trackId`'s backoff window. */
  function scheduleLoadRetry(trackId: string): void {
    if (loadRetryTimer) clearTimeout(loadRetryTimer);
    const attempts = loadFailures.get(trackId)?.attempts ?? 1;
    loadRetryTimer = setTimeout(() => {
      loadRetryTimer = null;
      // Only if the room still wants what failed; a newer track has its own load (and its own timer).
      if (ctx && lastRoom?.track && loadedTrackId !== lastRoom.track.id && !loadBackoffHolds(lastRoom.track.id)) {
        void loadTrack(lastRoom);
      }
    }, loadBackoffMs(attempts) + 1);
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
                // A superseded download stops here instead of competing with the track that replaced it.
                if (loadingTrackId !== track.id) throw new Error("superseded by a newer track");
                done[i] = fraction;
                // Decode is the last 5 %: a stem that has arrived is not yet a stem you can play.
                loadProgress = (done.reduce((a, b) => a + b, 0) / total) * 0.95;
                emit.emit("audio", state, loadProgress);
              });
          done[i] = 1;
          return [stem, buffer] as const;
        }),
      );
      // The track changed again while this one was downloading: the newer load owns the engine now.
      if (loadingTrackId !== track.id) return;
      const map = new Map<string, BufferLike>(buffers);
      originalBuffers = map;
      appliedPitchSemitones = 0;
      pitchedCache.clear(); // pitched copies are ~35MB each; only the current track earns them
      scheduler?.setBuffers(map, track.id);
      loadedTrackId = track.id;
      loadFailures.delete(track.id);
      loadProgress = 1;
      setState("ready");
      emit.emit("audio", state, loadProgress);
      // AUDIO_READY means *every* stem is decoded, never "the first one is playable".
      lastReadyAnnounceAt = performance.now();
      send({ type: "AUDIO_READY", trackId: track.id });
      reschedule(true, "track loaded");
      void ensurePitchedBuffers(); // a CHOIR assignment may already be waiting for this track
    } catch (err) {
      // A superseded load failing is not news, and must not drag the state back from the live one.
      if (loadingTrackId !== track.id) return;
      const previous = loadFailures.get(track.id);
      loadFailures.set(track.id, { attempts: (previous?.attempts ?? 0) + 1, atMs: performance.now() });
      emit.emit("error", "AUDIO_LOAD_FAILED", err instanceof Error ? err.message : String(err));
      setState("unlocked");
      scheduleLoadRetry(track.id);
    } finally {
      if (loadingTrackId === track.id) loadingTrackId = null;
    }
  }

  /**
   * CHOIR: swap the scheduler onto buffers rendered at the assignment's pitch. The render is slow
   * (seconds of chunked WSOLA for a full song), so the phone keeps playing the current buffers and
   * hard-resyncs onto the pitched ones the moment they are ready — the same resync path a late
   * joiner takes. Renders are cached per (track, semitone); the room's 2 Hz snapshots make this
   * re-entrant, so an in-flight render key blocks duplicates.
   */
  async function ensurePitchedBuffers(): Promise<void> {
    if (!ctx || !scheduler || !loadedTrackId || !originalBuffers) return;
    if (typeof ctx.createBuffer !== "function") return; // test fakes have no buffer factory
    const trackId = loadedTrackId;
    const want = lastAssignment?.pitchSemitones ?? 0;
    if (want === appliedPitchSemitones) return;
    if (want === 0) {
      scheduler.setBuffers(originalBuffers, trackId);
      appliedPitchSemitones = 0;
      reschedule(true, "pitch cleared");
      return;
    }
    const key = `${trackId}:${want}`;
    let pitched = pitchedCache.get(key);
    if (!pitched) {
      if (pitchJobKey === key) return; // already rendering this exact variant
      pitchJobKey = key;
      try {
        const rendered = new Map<string, BufferLike>();
        for (const [stem, raw] of originalBuffers) {
          const src = raw as AudioBuffer;
          const shifted = await pitchShiftMono(src.getChannelData(0), want);
          // Track changed mid-render (stale), or the engine was disposed under us (no context).
          if (loadedTrackId !== trackId || !ctx) return;
          const out = ctx.createBuffer(1, shifted.length, src.sampleRate);
          out.copyToChannel(shifted as Float32Array<ArrayBuffer>, 0);
          rendered.set(stem, out);
        }
        pitchedCache.set(key, rendered);
        pitched = rendered;
      } finally {
        if (pitchJobKey === key) pitchJobKey = null;
      }
    }
    // Only apply if this variant is still what the (possibly newer) assignment wants. `scheduler` is read
    // again on purpose: a zombie rebuild during the render replaced it.
    if (scheduler && loadedTrackId === trackId && (lastAssignment?.pitchSemitones ?? 0) === want) {
      scheduler.setBuffers(pitched, trackId);
      appliedPitchSemitones = want;
      reschedule(true, "pitch ready");
    }
  }

  /**
   * The plan may arrive before or after `runAsReference` starts waiting for it: the host taps Calibrate,
   * which both sends CALIBRATION_START and opens the microphone, and the server's reply races the
   * `getUserMedia` prompt. So a plan that arrives first is held.
   */
  const awaitPlan = (timeoutMs: number): Promise<CalibrationPlan> =>
    new Promise((resolve, reject) => {
      if (pendingPlan) {
        const plan = pendingPlan;
        pendingPlan = null;
        return resolve(plan);
      }
      const timer = setTimeout(() => {
        planWaiter = null;
        planRejecter = null;
        reject(new Error("CALIBRATION_PLAN did not arrive"));
      }, timeoutMs);
      planWaiter = (plan) => {
        clearTimeout(timer);
        planWaiter = null;
        planRejecter = null;
        resolve(plan);
      };
      planRejecter = (err) => {
        clearTimeout(timer);
        planWaiter = null;
        planRejecter = null;
        reject(err);
      };
    });

  /** Stops every click that has not sounded yet. One that is already audible is left to finish. */
  function cancelPendingClicks(): void {
    const at = ctx ? ctx.currentTime : 0;
    for (const click of pendingClicks) {
      try {
        // Only silence what is still in the future; cutting a sounding click would just be a glitch.
        if (click.atCtx > at) {
          click.gain.gain.setValueAtTime(0, at);
          click.source.stop(at);
        }
      } catch {
        /* a source that already ended throws; nothing to do */
      }
    }
    pendingClicks = [];
  }

  const calibration: HiveCalibration = {
    async runAsReference(o?: { onProgress?: (p: CalibrationProgress) => void }): Promise<CalibrationResult> {
      // The Calibrate tap doubles as unlock() for the host (docs/04): the worklet has to run in a
      // context that is already running, and this is the gesture we are inside.
      const context = ensureContext();
      if (context.state !== "running") await context.resume();
      const signal = { cancelled: false };
      cancelState = signal;
      try {
        return await runAsReference(
          {
            ctx: context,
            mapper,
            serverNow: () => clock.serverNow(),
            awaitPlan,
            report: (measurements) => send({ type: "CALIBRATION_REPORT", measurements }),
            signal,
          },
          o,
        );
      } finally {
        if (cancelState === signal) cancelState = null;
        pendingPlan = null;
        planWaiter = null;
      }
    },
    renderClick: (spec: ClickSpec, sampleRate: number) => renderClick(spec, sampleRate),
  };

  const engine: AudioEngine = {
    /**
     * Must be called from inside a tap. Everything WebKit cares about happens before the first await.
     */
    async unlock(): Promise<void> {
      disposed = false; // a tap after dispose() starts a fresh engine life rather than a half-dead one
      if (zombieSuspected && ctx) {
        // The watchdog saw 'running' with a frozen clock and resume() changed nothing — this
        // context will never make sound again. Rebuild it inside the tap; the decoded AudioBuffers
        // are context-independent and are re-attached below.
        zombieSuspected = false;
        /*
         * The old scheduler has to be stopped, not just dropped. It still owns a 1 Hz drift timer and a
         * 100 ms pattern timer, and against a context whose clock is frozen the drift check reads an
         * error that grows by a second every second — so it "resynced" forever, building a new set of
         * source and gain nodes on the dead context every tick for the rest of the session.
         */
        try {
          scheduler?.dispose();
        } catch {
          /* a dead context may refuse automation calls; the timers are stopped before those run */
        }
        try {
          ctx.onstatechange = null;
          void ctx.close().catch(() => {});
        } catch {
          /* already closed */
        }
        ctx = null;
        scheduler = null;
        resetWatchdogBaseline(); // the new context counts from zero; the old baseline means nothing
      }
      const context = ensureContext();
      if (loadedTrackId && originalBuffers && scheduler) {
        // No-op on a normal unlock (same buffers); after a zombie rebuild it re-points the fresh
        // scheduler at the decoded stems, keeping the active pitch variant when one was rendered.
        scheduler.setBuffers(pitchedCache.get(`${loadedTrackId}:${appliedPitchSemitones}`) ?? originalBuffers, loadedTrackId);
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
        const silent = context.createBufferSource();
        silent.buffer = context.createBuffer(1, 1, context.sampleRate);
        silent.connect(context.destination);
        silent.start(0);
      } catch {
        /* older engines: resume() alone is enough */
      }
      await context.resume();
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
      // The UI mirrors `audio.muted` off this event. Without it the button label never flipped,
      // so every press re-sent muted:true — a phone that could be muted but never unmuted.
      emit.emit("audio", state, loadProgress);
    },
    get muted() {
      return muted;
    },

    ctxNow: () => (ctx && ctx.state !== "closed" ? ctx.currentTime : null),

    applyRoom(room: RoomState, assignment: Assignment | null): void {
      lastRoom = room;
      lastAssignment = assignment;
      /*
       * CALIBRATION_CANCEL arrives as a state change, not as a message to this client: the clicks were
       * handed out up front as SCHEDULED_ACTIONs, so the server cannot un-send them and each phone has
       * to silence its own. Watching the transition (ran → idle) rather than the bare value means a
       * phone that joins an already-idle room does not try to cancel something it never scheduled.
       */
      const calState = room.calibration.state;
      if (calState === "countdown" || calState === "running") sawCalibrationRun = true;
      else if (calState === "idle" && sawCalibrationRun) {
        sawCalibrationRun = false;
        cancelPendingClicks();
        if (cancelState) cancelState.cancelled = true;
        /*
         * Setting the flag is not enough on its own: a reference that is still blocked in awaitPlan
         * would hold the microphone until PLAN_TIMEOUT_MS (10 s) elapsed, and on iOS every one of those
         * seconds keeps the audio session in play-and-record. Reject the wait so the run unwinds now.
         */
        planRejecter?.(new CalibrationCancelledError());
      }
      if (calState === "done" || calState === "failed") sawCalibrationRun = false;
      /*
       * Re-announce readiness when the server's own snapshot says it does not know. A server restart with
       * a fresh room loses `audioReadyTrackId`, and AUDIO_READY was only ever sent once, at the end of
       * decoding — so the host's "9 of 12 ready" would stay wrong for the rest of the set and a
       * readiness gate on the server would never open. Driving it off the server's view makes it
       * self-limiting: it stops the moment the snapshot reflects it, and the rate guard covers the one
       * snapshot period in which our message is still in flight.
       */
      if (ctx && loadedTrackId && room.track?.id === loadedTrackId) {
        const known = room.clients[host.clientId]?.audioReadyTrackId;
        const since = performance.now() - lastReadyAnnounceAt;
        if (known !== loadedTrackId && since >= READY_REANNOUNCE_MIN_MS) {
          lastReadyAnnounceAt = performance.now();
          send({ type: "AUDIO_READY", trackId: loadedTrackId });
        }
      }
      if (!ctx) return; // still locked: nothing to schedule, the snapshot is remembered
      /*
       * `loadingTrackId`, not `state === "loading"`: a second track change that lands while the first is
       * still downloading has to start *its* load now. Waiting for the stale one to finish meant decoding
       * a song nobody will hear, announcing AUDIO_READY for it, and then relying on a further snapshot —
       * which a quiet room does not send — to notice the room had moved on.
       */
      if (room.track && room.track.id !== loadedTrackId && room.track.id !== loadingTrackId && !loadBackoffHolds(room.track.id)) {
        if (loadedTrackId && room.track.id !== loadedTrackId) {
          loadedTrackId = null; // SET_TRACK to something else: drop the old buffers' claim
          /*
           * A playlist advance arrives LEAD_MS before the old song ends, with the new one already
           * "playing" from a start a few seconds ahead. The old song's last moments are allowed to play
           * out (the scheduler bounds how long); a manual SET_TRACK stops the transport, and is a cut.
           */
          const t = room.transport;
          const handover =
            t.state === "playing" && scheduler && clock.offsetMs !== null
              ? scheduler.ctxTimeForServerTime(t.serverTimeAtTrackZero, assignment, useOutputLatency())
              : undefined;
          scheduler?.stopAll("track changed", handover);
        }
        void loadTrack(room);
        return;
      }
      void ensurePitchedBuffers(); // CHOIR: assignment pitch may have changed with this snapshot
      reschedule(false, "room state");
    },

    get lastCorrectionMs() {
      return scheduler?.lastCorrectionMs ?? 0;
    },
    get playheadErrorMs() {
      // 0 when nothing is playing: there is no playhead to be wrong about.
      return scheduler?.playing ? scheduler.lastDriftErrorMs : 0;
    },
    get ctxState() {
      // The cast keeps iOS's 'interrupted' honest; it is a real value the DOM union omits.
      return ctx ? (ctx.state as AudioContextState | "interrupted") : null;
    },
    get sampleRate() {
      return ctx?.sampleRate ?? null;
    },
    get outputLatencyMs() {
      return readOutputLatencyMs();
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
      const requested = mapper.ctxTimeForNow(serverTimeToExecute, ctxNow, host.now()) - comp - ol;
      /*
       * A click we cannot place on time is not played at all.
       *
       * The reference measures each click against the instant the plan promised, so a click fired late —
       * because its SCHEDULED_ACTION arrived late, or the tab was throttled — produces a residual that is
       * *wrong by that lateness*, and the server writes it into `calibratedOffsetMs` as though it were
       * this phone's output latency. Playing it anyway trades a missing measurement for a confidently
       * wrong one, and a wrong offset is the accumulation base for the next run (P0-6, CALIBRATION_RESET).
       * Dropping it shows up as "not heard — run again", which is the honest outcome and one the UI
       * already handles.
       *
       * The tolerance is one render quantum: inside that, Web Audio cannot place the click more precisely
       * anyway, so refusing would only make calibration flakier without making it more accurate.
       */
      if (requested < ctxNow - RENDER_QUANTUM / ctx.sampleRate) {
        clicksSkipped++;
        return;
      }
      const at = Math.max(ctxNow, requested);
      source.start(at);
      pendingClicks.push({ source, gain, atCtx: at });
      source.onended = () => {
        pendingClicks = pendingClicks.filter((c) => c.source !== source);
      };
    },

    onCalibrationPlan(plan: CalibrationPlan): void {
      if (planWaiter) planWaiter(plan);
      else pendingPlan = plan;
    },

    calibration,

    get debug() {
      return {
        startCtxForZero: scheduler?.startCtxForZero ?? null,
        lastDecision: scheduler?.lastDecision ?? null,
        playing: scheduler?.playing ?? false,
        ctxState: ctx ? (ctx.state as string) : null,
        loadedTrackId,
        // B9e: what the rate trim is doing right now, and how much drift it is chasing. A phone parked at
        // the ppm cap is the signal that slewing is losing and a crossfade is coming.
        driftErrorMs: scheduler?.lastDriftErrorMs ?? 0,
        clicksSkipped,
        loadAttempts: [...loadFailures].map(([id, f]) => `${id}×${f.attempts}`),
        slewPpm: scheduler?.lastSlewPpm ?? 0,
        slewEnabled: scheduler?.slewEnabled ?? false,
        resyncCount: scheduler?.resyncCount ?? 0,
      };
    },

    /**
     * Ends this engine for good. Everything that could keep it alive is released here, because the
     * closure holds the decoded stems (tens to hundreds of MB): one surviving timer or DOM listener and
     * a phone that leaves a hive and joins another carries both songs until the tab dies.
     */
    dispose(): void {
      disposed = true;
      if (loadRetryTimer) clearTimeout(loadRetryTimer);
      loadRetryTimer = null;
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = null;
      if (onVisibilityChange && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      onVisibilityChange = null;
      listenersBound = false;
      try {
        scheduler?.dispose();
      } catch {
        /* a context that is already gone may refuse; nothing left to stop */
      }
      scheduler = null;
      if (wakeLock && !wakeLock.released) void wakeLock.release().catch(() => {});
      wakeLock = null;
      if (ctx) {
        ctx.onstatechange = null;
        void ctx.close().catch(() => {});
      }
      ctx = null;
      loadedTrackId = null;
      loadingTrackId = null; // an in-flight download now counts as superseded
      originalBuffers = null;
      pitchedCache.clear();
      lastRoom = null;
      lastAssignment = null;
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
      try {
        onProgress(Math.min(1, received / totalBytes));
      } catch (err) {
        void reader.cancel().catch(() => {});
        throw err;
      }
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
