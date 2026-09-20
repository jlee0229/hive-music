/**
 * The scheduler: turns `room.transport` + the assignment into `source.start(when, offset)` calls.
 *
 * Everything here is written against narrow structural interfaces (`CtxLike`, `SourceLike`, …) that the
 * real Web Audio types satisfy, for one reason: the arithmetic below *is* the ≤10 ms target, and it has
 * to be testable without a browser. A fake context records what was scheduled; `lastDecision` exposes
 * the numbers so a unit test can assert the mapping for start-from-zero, paused, late join and seek.
 *
 * The rule that shapes the whole file (docs/02-protocol.md §1, docs/03-sync-engine.md): there is one
 * timeline, `room.transport`, and a phone NEVER waits for an instant to arrive. It computes where the
 * music should be right now and starts there. Late join, reconnect, a resumed tab and a seek are all
 * the same code path.
 */
import {
  evaluatePattern, RESYNC_CROSSFADE_MS, RESYNC_THRESHOLD_MS,
  type Assignment, type Pattern, type Transport,
} from "@hive/protocol";
import type { ClockModel, CtxMapper } from "./clock";

// ---- the slice of Web Audio this file needs ---------------------------------
export interface ParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}
export interface NodeLike {
  connect(destination: never): unknown;
  disconnect(): unknown;
}
export interface GainLike {
  readonly gain: ParamLike;
  connect(destination: never): unknown;
  disconnect(): unknown;
}
export interface BufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
}
export interface SourceLike {
  buffer: BufferLike | null;
  start(when?: number, offset?: number): unknown;
  stop(when?: number): unknown;
  connect(destination: never): unknown;
  disconnect(): unknown;
  onended: ((ev: never) => unknown) | null;
}
export interface CtxLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  readonly outputLatency?: number;
  createGain(): GainLike;
  createBufferSource(): SourceLike;
}

// ---- tuning constants local to scheduling ----------------------------------
/** A start further out than this is scheduled exactly; anything nearer starts now at an offset. */
export const FUTURE_START_MARGIN_SEC = 0.05;
/** Safety margin when starting "now": enough for one render quantum plus slop. */
export const LATE_START_MARGIN_SEC = 0.02;
/** Time constant for gain ramps (`setTargetAtTime`), seconds. */
export const GAIN_RAMP_TC_SEC = 0.02;
/** Pattern automation: how often we top up, and how far ahead we write. */
export const PATTERN_TICK_MS = 100;
export const PATTERN_LOOKAHEAD_MS = 200;
/** Samples per second of pattern curve written into `setValueCurveAtTime`. */
export const PATTERN_CURVE_HZ = 200;
/** Fade applied when stopping so a pause never clicks. */
export const STOP_FADE_SEC = 0.01;
/** How often the playhead is compared with the timeline while playing. */
export const DRIFT_CHECK_INTERVAL_MS = 1000;
/** A hard resync starts this far ahead, leaving room to build the new branch. */
export const RESYNC_START_MARGIN_SEC = 0.05;

export const gainFromDb = (db: number): number => (db <= -60 ? 0 : 10 ** (db / 20));

// ---- the decision ----------------------------------------------------------
export interface StartDecision {
  /** `source.start(when)` — ctx seconds. */
  whenCtx: number;
  /** `source.start(_, offset)` — seconds into the track. */
  offsetSec: number;
  /** Virtual ctx time at which track position 0 leaves this speaker (may be in the past). */
  startCtxForZero: number;
  /** "scheduled" when the start is still ahead of us, "immediate" when we join mid-track. */
  mode: "scheduled" | "immediate";
}

export interface DecideInput {
  ctxNow: number;
  /** Ctx time at which track position 0 leaves this device's speaker. */
  startCtxForZero: number;
  durationSec: number;
}

/**
 * The one piece of arithmetic the whole sync target rests on. Pure, exported, and tested directly.
 *
 * Returns null when the track has already finished, which is not an error: a phone that joins a room
 * 70 s into a 60 s track has nothing to play and must not start a source at a negative offset.
 */
export function decideStart({ ctxNow, startCtxForZero, durationSec }: DecideInput): StartDecision | null {
  if (startCtxForZero >= ctxNow + FUTURE_START_MARGIN_SEC) {
    return { whenCtx: startCtxForZero, offsetSec: 0, startCtxForZero, mode: "scheduled" };
  }
  const whenCtx = ctxNow + LATE_START_MARGIN_SEC;
  const offsetSec = whenCtx - startCtxForZero;
  /*
   * P0-5. The start is in the future but nearer than the margin — a lead of 20–50 ms, which is what a
   * phone sees when ROOM_STATE arrives late in the PLAY window. `offsetSec` is then NEGATIVE, and
   * clamping it to 0 played track position 0 at `ctxNow + LATE_START_MARGIN_SEC`: up to 30 ms EARLY.
   * Worse, the branch records the *ideal* startCtxForZero, so the drift check compared the ideal against
   * the ideal, read zero error, and never corrected it — every phone in this window started early
   * together with green health, while a phone that got the snapshot later took the correct late path and
   * sat up to 30 ms behind them. Web Audio accepts any future `when`, so schedule it exactly.
   */
  if (offsetSec < 0) return { whenCtx: startCtxForZero, offsetSec: 0, startCtxForZero, mode: "scheduled" };
  if (offsetSec >= durationSec) return null;
  return { whenCtx, offsetSec, startCtxForZero, mode: "immediate" };
}

export interface SchedulerDeps {
  ctx: CtxLike;
  clock: ClockModel;
  mapper: CtxMapper;
  /** localNow(), injected so tests can drive time. */
  now: () => number;
}

/** What `apply()` did, for tests, /diag and the drift check. */
export interface ApplyResult {
  action: "started" | "restarted" | "stopped" | "unchanged" | "idle" | "finished";
  decision: StartDecision | null;
  reason: string;
}

interface Branch {
  sources: Map<string, SourceLike>;
  stemGains: Map<string, GainLike>;
  patternGain: GainLike;
  /**
   * Crossfade only. It has to be its own node: during WAVE or STROBE the pattern gain is under
   * automation, and fading on the same param would fight the curve (or be erased by it).
   */
  fadeGain: GainLike;
  /** Ctx time of track position 0 for this branch (what the drift check compares against). */
  startCtxForZero: number;
  startedAtCtx: number;
  startOffsetSec: number;
  stopped: boolean;
}

/** Identity of a schedule: if any of this changes while playing, the branch must be rebuilt. */
interface AppliedKey {
  trackId: string;
  transportState: Transport["state"];
  serverTimeAtTrackZero: number;
  /**
   * The timing half of the assignment. A change here moves where the music should be, so it is a
   * reschedule and not a ramp — but only once it is worth the interruption, hence the threshold below.
   */
  timingShiftMs: number;
}

/** delayMs − compensationMs: the net shift of this device's playhead, in ms. */
const timingShiftOf = (a: Assignment | null): number => (a?.delayMs ?? 0) - (a?.compensationMs ?? 0);

export class Scheduler {
  /** Master gain: local mute only, never part of the assignment. */
  private readonly master: GainLike;
  private buffers = new Map<string, BufferLike>();
  private durationSec = 0;
  private trackId: string | null = null;
  private branches: Branch[] = [];
  private applied: AppliedKey | null = null;
  private assignment: Assignment | null = null;
  private patternTimer: ReturnType<typeof setInterval> | null = null;
  private patternWrittenUntilMs = 0;
  /** Serialized last pattern: ROOM_STATE arrives at 2 Hz and must not restart identical automation. */
  private patternKey: string | null = null;
  private muted = false;

  lastDecision: StartDecision | null = null;
  /** Last hard resync applied, ms. Feeds `syncErrMs`; keeps its value between resyncs. */
  lastCorrectionMs = 0;
  /** Most recent drift measurement, ms, corrected or not (diagnostics). */
  lastDriftErrorMs = 0;
  resyncCount = 0;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private useOutputLatency = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.master = deps.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(deps.ctx.destination as never);
  }

  get playing(): boolean {
    return this.branches.some((b) => !b.stopped);
  }

  /** Ctx time of track position 0 on the live branch, or null when nothing is scheduled. */
  get startCtxForZero(): number | null {
    const live = this.branches.find((b) => !b.stopped);
    return live ? live.startCtxForZero : null;
  }

  setBuffers(buffers: Map<string, BufferLike>, trackId: string): void {
    this.buffers = buffers;
    this.trackId = trackId;
    this.durationSec = Math.max(0, ...[...buffers.values()].map((b) => b.duration));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.master.gain.setTargetAtTime(muted ? 0 : 1, this.deps.ctx.currentTime, GAIN_RAMP_TC_SEC);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Where track position `p` leaves this device's speaker, in ctx seconds — the formula from
   * docs/02-protocol.md §1. `compensationMs` is positive when the device is *late*, so it is
   * subtracted: start earlier to come out on time.
   */
  ctxTimeForTrackPosition(serverTimeAtTrackZero: number, p: number, a: Assignment | null, useOutputLatency: boolean): number {
    return this.ctxTimeForServerTime(serverTimeAtTrackZero + p * 1000, a, useOutputLatency);
  }

  /**
   * The ctx time at which whatever is scheduled for `serverTime` actually leaves this speaker — the
   * formula from docs/02-protocol.md §1. Everything time-critical goes through this one function: source
   * starts, the drift check, and scene-boundary gain ramps. A ramp computed without the compensation
   * lands ~compensationMs (≈60 ms on iOS) after the audio it is supposed to gate, which is audible on a
   * hard STROBE edge (P1-10).
   */
  ctxTimeForServerTime(serverTime: number, a: Assignment | null, useOutputLatency: boolean): number {
    const ctxNow = this.deps.ctx.currentTime;
    const base = this.deps.mapper.ctxTimeForNow(serverTime, ctxNow, this.deps.now());
    const delaySec = (a?.delayMs ?? 0) / 1000;
    const compSec = (a?.compensationMs ?? 0) / 1000;
    const olSec = useOutputLatency ? this.deps.ctx.outputLatency || 0 : 0;
    return base + delaySec - compSec - olSec;
  }

  /**
   * Called on every ROOM_STATE, and again on `visibilitychange` → visible and `statechange` → running.
   * Idempotent: an unchanged transport is a no-op, so 2 Hz snapshots do not restart the audio.
   */
  apply(
    transport: Transport,
    assignment: Assignment | null,
    opts: { trackId: string | null; useOutputLatency: boolean; force?: boolean },
  ): ApplyResult {
    this.assignment = assignment;
    this.useOutputLatency = opts.useOutputLatency;

    /*
     * P0-3. `assignment === null` means the planner decided this device is not a speaker — a host that
     * turned "use this phone as a speaker" off, or a client whose record is gone. Falling through built a
     * branch with `gainFromDb(undefined ?? 0)` on every stem and `compensationMs` 0: the phone blared
     * every stem, uncompensated and out of sync with the room. Silence is the only correct reading. When
     * an assignment reappears the normal path below schedules it from the transport, i.e. a late join.
     */
    if (assignment === null) {
      const wasPlaying = this.playing;
      if (wasPlaying) this.stopAll("no assignment: this device is not a speaker");
      return { action: wasPlaying ? "stopped" : "idle", decision: null, reason: "assignment is null" };
    }

    if (transport.state !== "playing" || !opts.trackId || opts.trackId !== this.trackId || this.buffers.size === 0) {
      const wasPlaying = this.playing;
      if (wasPlaying) this.stopAll("transport is not playing, or the track is not loaded");
      this.applied = null;
      return { action: wasPlaying ? "stopped" : "idle", decision: null, reason: transport.state };
    }

    const key: AppliedKey = {
      trackId: opts.trackId,
      transportState: "playing",
      serverTimeAtTrackZero: transport.serverTimeAtTrackZero,
      timingShiftMs: timingShiftOf(assignment),
    };
    /*
     * A timing shift under RESYNC_THRESHOLD_MS is left to the drift check (B4) to absorb; a bigger one
     * is rescheduled now. This matters for WAVE: its delayMs is up to 300 ms, so switching into WAVE
     * mid-song has to move the playhead immediately or the mode does nothing audible.
     */
    const same =
      this.applied !== null &&
      this.applied.trackId === key.trackId &&
      this.applied.transportState === key.transportState &&
      this.applied.serverTimeAtTrackZero === key.serverTimeAtTrackZero &&
      Math.abs(this.applied.timingShiftMs - key.timingShiftMs) <= RESYNC_THRESHOLD_MS;

    if (same && this.playing) {
      // Gains and patterns may still have changed — that is a ramp, never a restart (B5e).
      this.applyAssignmentGains(assignment);
      if (opts.force) {
        /*
         * A resumed tab or a context that came back from 'interrupted' lands here. Drift-check rather
         * than restart: the check will crossfade if the playhead really moved, and a tab that was
         * hidden for two seconds needs no interruption at all. Restarting on every visibilitychange
         * would put an audible gap into the most common recovery path there is.
         */
        const drift = this.checkDrift(assignment, opts.useOutputLatency);
        return {
          action: drift?.resynced ? "restarted" : "unchanged",
          decision: this.lastDecision,
          reason: drift ? `drift ${drift.errorMs.toFixed(2)} ms` : "forced re-check",
        };
      }
      return { action: "unchanged", decision: this.lastDecision, reason: "same transport" };
    }

    const startCtxForZero = this.ctxTimeForTrackPosition(key.serverTimeAtTrackZero, 0, assignment, opts.useOutputLatency);
    const decision = decideStart({ ctxNow: this.deps.ctx.currentTime, startCtxForZero, durationSec: this.durationSec });
    if (!decision) {
      const wasPlaying = this.playing;
      if (wasPlaying) this.stopAll("track already finished");
      this.applied = key;
      return { action: "finished", decision: null, reason: "past the end of the track" };
    }

    const restarted = this.playing;
    if (restarted) this.stopAll("rescheduling");
    this.applied = key; // set before startBranch: the drift check reads it
    this.startBranch(decision, assignment);
    this.startDriftCheck();
    this.lastDecision = decision;
    return {
      action: restarted ? "restarted" : "started",
      decision,
      reason: decision.mode === "scheduled" ? "scheduled start" : "joined mid-track",
    };
  }

  /** Builds one branch of the graph and starts every stem at the identical ctx time and offset. */
  private startBranch(decision: StartDecision, assignment: Assignment | null, fadeInFrom = 1): Branch {
    const { ctx } = this.deps;
    const fadeGain = ctx.createGain();
    fadeGain.gain.value = fadeInFrom;
    fadeGain.connect(this.master as never);
    const patternGain = ctx.createGain();
    patternGain.gain.value = 1;
    patternGain.connect(fadeGain as never);

    const branch: Branch = {
      sources: new Map(),
      stemGains: new Map(),
      patternGain,
      fadeGain,
      startCtxForZero: decision.startCtxForZero,
      startedAtCtx: decision.whenCtx,
      startOffsetSec: decision.offsetSec,
      stopped: false,
    };

    for (const [stem, buffer] of this.buffers) {
      const gain = ctx.createGain();
      gain.gain.value = gainFromDb(assignment?.gainsDb?.[stem] ?? 0);
      gain.connect(patternGain as never);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain as never);
      branch.stemGains.set(stem, gain);
      branch.sources.set(stem, source);
    }
    // One synchronous sequence, identical `when` and `offset`: any skew here is skew between stems on
    // the same phone, which is the one error we can make exactly zero.
    for (const source of branch.sources.values()) source.start(decision.whenCtx, decision.offsetSec);

    this.branches.push(branch);
    // A new branch needs its own curve even when the pattern object is unchanged.
    this.startPatternAutomation(assignment?.pattern ?? null, { restart: true });
    return branch;
  }

  /** Stops every branch with a short fade so a pause does not click. */
  stopAll(_reason = "stop"): void {
    this.patternKey = null;
    const at = this.deps.ctx.currentTime;
    for (const branch of this.branches) this.fadeOutAndStop(branch, at, STOP_FADE_SEC);
    this.branches = [];
    this.stopPatternAutomation();
    this.stopDriftCheck();
  }

  /** Ramps a branch's fade node to 0 and stops its sources after the fade. */
  private fadeOutAndStop(branch: Branch, at: number, fadeSec: number): void {
    if (branch.stopped) return;
    branch.stopped = true;
    branch.fadeGain.gain.cancelScheduledValues(at);
    branch.fadeGain.gain.setValueAtTime(branch.fadeGain.gain.value, at);
    branch.fadeGain.gain.linearRampToValueAtTime(0, at + fadeSec);
    for (const source of branch.sources.values()) {
      try {
        source.stop(at + fadeSec);
      } catch {
        /* a source that never started throws on stop in some engines */
      }
    }
  }

  // ---- drift check and hard resync (B4) -------------------------------------
  /**
   * Playhead error, ms. Positive = this phone is ahead of the timeline.
   *
   * The whole check is one subtraction, and that is the point: the ideal ctx time for track position 0
   * *computed now* minus the one we actually scheduled with. Because it reuses
   * `ctxTimeForTrackPosition`, the drift check cannot disagree with the scheduler about the formula —
   * a separate derivation is exactly how a sign error survives in one path and not the other.
   *
   * It catches every source of error at once: the clock offset moving (the mapping moves), a nudge or a
   * mode change (compensation and delay are inputs), and the audio clock drifting against the system
   * clock (`ctx.currentTime` advances faster than real time, so the ideal start slides later).
   */
  driftErrorMs(assignment: Assignment | null, useOutputLatency: boolean): number | null {
    const branch = this.branches.find((b) => !b.stopped);
    if (!branch || this.applied === null) return null;
    const ideal = this.ctxTimeForTrackPosition(this.applied.serverTimeAtTrackZero, 0, assignment, useOutputLatency);
    return (ideal - branch.startCtxForZero) * 1000;
  }

  /**
   * Runs the drift check and, past RESYNC_THRESHOLD_MS, hard-resyncs: a new branch at the corrected
   * position fades in over RESYNC_CROSSFADE_MS while the old one fades out. A crossfade rather than a
   * stop-and-start because the two branches are the same audio a few ms apart — the artifact is a brief
   * phasiness instead of a hole.
   */
  checkDrift(assignment: Assignment | null, useOutputLatency: boolean): { errorMs: number; resynced: boolean } | null {
    const errorMs = this.driftErrorMs(assignment, useOutputLatency);
    if (errorMs === null) return null;
    this.lastDriftErrorMs = errorMs;
    if (Math.abs(errorMs) <= RESYNC_THRESHOLD_MS) return { errorMs, resynced: false };

    const ctxNow = this.deps.ctx.currentTime;
    const startCtxForZero = this.ctxTimeForTrackPosition(
      this.applied!.serverTimeAtTrackZero,
      0,
      assignment,
      useOutputLatency,
    );
    const whenCtx = ctxNow + RESYNC_START_MARGIN_SEC;
    const offsetSec = whenCtx - startCtxForZero;
    if (offsetSec < 0 || offsetSec >= this.durationSec) {
      // The correction would land outside the track: nothing useful to fade to.
      return { errorMs, resynced: false };
    }
    const decision: StartDecision = { whenCtx, offsetSec, startCtxForZero, mode: "immediate" };
    const fadeSec = RESYNC_CROSSFADE_MS / 1000;
    const old = this.branches.filter((b) => !b.stopped);

    const fresh = this.startBranch(decision, assignment, 0);
    fresh.fadeGain.gain.setValueAtTime(0, whenCtx);
    fresh.fadeGain.gain.linearRampToValueAtTime(1, whenCtx + fadeSec);
    for (const branch of old) this.fadeOutAndStop(branch, whenCtx, fadeSec);
    this.branches = this.branches.filter((b) => !b.stopped);

    this.lastDecision = decision;
    this.lastCorrectionMs = errorMs;
    this.resyncCount++;
    return { errorMs, resynced: true };
  }

  private startDriftCheck(): void {
    if (this.driftTimer) return;
    this.driftTimer = setInterval(() => {
      if (!this.playing) return this.stopDriftCheck();
      this.checkDrift(this.assignment, this.useOutputLatency);
    }, DRIFT_CHECK_INTERVAL_MS);
  }
  private stopDriftCheck(): void {
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  // ---- gains and patterns (B5e) ---------------------------------------------
  /**
   * A mode switch is a gain change, never a reload. `applyAtServerTime` is honoured by ramping at the
   * mapped ctx time, so every phone in the room moves at the same instant.
   */
  applyAssignmentGains(assignment: Assignment | null): void {
    this.assignment = assignment;
    const ctxNow = this.deps.ctx.currentTime;
    // P1-10: the ramp has to land where the *audio* for that server time plays, not where the server
    // time maps to bare ctx, or it trails the sound it gates by this phone's compensation.
    const at =
      assignment?.applyAtServerTime != null
        ? Math.max(ctxNow, this.ctxTimeForServerTime(assignment.applyAtServerTime, assignment, this.useOutputLatency))
        : ctxNow;
    for (const branch of this.branches) {
      if (branch.stopped) continue;
      for (const [stem, gain] of branch.stemGains) {
        gain.gain.setTargetAtTime(gainFromDb(assignment?.gainsDb?.[stem] ?? 0), at, GAIN_RAMP_TC_SEC);
      }
    }
    this.startPatternAutomation(assignment?.pattern ?? null);
  }

  /**
   * Pattern automation runs on the shared clock, not on messages: every phone evaluates the same
   * `evaluatePattern(pattern, trackTimeMs)` and writes the next PATTERN_LOOKAHEAD_MS of values ahead of
   * the playhead, so WAVE and STROBE travel across the room without a single per-tick packet.
   */
  private startPatternAutomation(pattern: Pattern | null, opts: { restart?: boolean } = {}): void {
    const key = pattern ? JSON.stringify(pattern) : null;
    if (key === this.patternKey && !opts.restart) return;
    this.patternKey = key;
    if (!pattern) {
      this.stopPatternAutomation();
      for (const branch of this.branches) {
        if (branch.stopped) continue;
        branch.patternGain.gain.cancelScheduledValues(this.deps.ctx.currentTime);
        branch.patternGain.gain.setTargetAtTime(1, this.deps.ctx.currentTime, GAIN_RAMP_TC_SEC);
      }
      return;
    }
    this.patternWrittenUntilMs = 0;
    this.writePatternWindow(pattern);
    if (this.patternTimer) return;
    this.patternTimer = setInterval(() => {
      const p = this.assignment?.pattern ?? null;
      if (!p) return this.stopPatternAutomation();
      this.writePatternWindow(p);
    }, PATTERN_TICK_MS);
  }

  private stopPatternAutomation(): void {
    if (this.patternTimer) clearInterval(this.patternTimer);
    this.patternTimer = null;
    this.patternWrittenUntilMs = 0;
  }

  /**
   * Writes PATTERN_LOOKAHEAD_MS of curve starting wherever we left off. Two cases have to be handled
   * or the automation silently never runs:
   *  - the start is still in the future, so the playhead position is *negative*; the window then begins
   *    at track position 0 and the curve is scheduled at the branch's start time.
   *  - the window we would write begins in the past (a tick was late, or the tab was throttled); the
   *    window is shifted forward so `setValueCurveAtTime` gets a time it will accept, and the curve
   *    stays aligned to the music rather than to the moment we happened to wake up.
   */
  private writePatternWindow(pattern: Pattern): void {
    const branch = this.branches.find((b) => !b.stopped);
    if (!branch) return;
    const ctxNow = this.deps.ctx.currentTime;
    const positionNowMs = (branch.startOffsetSec + (ctxNow - branch.startedAtCtx)) * 1000;
    let fromMs = Math.max(0, positionNowMs, this.patternWrittenUntilMs);
    let startCtx = branch.startedAtCtx + (fromMs / 1000 - branch.startOffsetSec);
    if (startCtx < ctxNow) {
      fromMs += (ctxNow - startCtx) * 1000;
      startCtx = ctxNow;
    }
    const toMs = fromMs + PATTERN_LOOKAHEAD_MS;

    const points = Math.max(2, Math.round(((toMs - fromMs) / 1000) * PATTERN_CURVE_HZ));
    const curve = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      curve[i] = evaluatePattern(pattern, fromMs + ((toMs - fromMs) * i) / (points - 1));
    }
    try {
      branch.patternGain.gain.setValueCurveAtTime(curve, startCtx, (toMs - fromMs) / 1000);
    } catch {
      /* Web Audio throws when curves overlap; the next tick starts after patternWrittenUntilMs. */
    }
    this.patternWrittenUntilMs = toMs;
  }

  dispose(): void {
    this.stopAll("dispose");
    this.stopPatternAutomation();
    this.stopDriftCheck();
    this.master.disconnect();
  }
}
