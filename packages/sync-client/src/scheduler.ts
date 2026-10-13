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
  evaluatePattern, PLAYBACK_RATE_DEADBAND_MS, PLAYBACK_RATE_MAX_PPM, PLAYBACK_RATE_SLEW_DEFAULT,
  PLAYBACK_RATE_TAU_SEC, RESYNC_CROSSFADE_MS, RESYNC_THRESHOLD_MS,
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
  /**
   * Optional so a stand-in without one still satisfies the interface — and so an engine that refuses to
   * automate it degrades to the crossfade-only behaviour rather than throwing. Every browser we target
   * has it (it is an AudioParam on AudioBufferSourceNode).
   */
  playbackRate?: ParamLike;
}
export interface CtxLike {
  /** Optional: when present, the drift check stands down unless it reads "running". */
  readonly state?: string;
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
/** A top-up shorter than this is left for the next tick, seconds. */
export const PATTERN_MIN_WINDOW_SEC = 0.02;
/**
 * Gap left between one pattern curve and the next, seconds. Web Audio refuses a curve that overlaps one
 * already scheduled — by a single ulp of float error is enough — so consecutive curves are kept visibly
 * apart. The gain simply holds its last value across the gap (a handful of samples).
 */
export const PATTERN_CURVE_GAP_SEC = 1e-4;
/** Fade applied when stopping so a pause never clicks. */
export const STOP_FADE_SEC = 0.01;
/** How often the playhead is compared with the timeline while playing. */
export const DRIFT_CHECK_INTERVAL_MS = 1000;
/**
 * The audio clock counts as stalled when it advanced less than this fraction of the wall time between
 * two drift checks. Generous on purpose: a real clock is within a few hundred ppm of 1.
 */
export const AUDIO_CLOCK_STALLED_RATIO = 0.5;
/** A hard resync starts this far ahead, leaving room to build the new branch. */
export const RESYNC_START_MARGIN_SEC = 0.05;
/**
 * How long a branch that is being replaced may keep sounding while it waits for its successor's start,
 * seconds. Long enough for the server's LEAD_MS (the end of a song, a restart from the top), far too
 * short for "the old song plays on for five seconds after the host skipped it".
 */
export const HANDOVER_MAX_SEC = 2;

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
  /** The buffer set this branch was built from, so a swap (CHOIR's pitched render) can be detected. */
  buffers: Map<string, BufferLike>;
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
  /** Ctx time its sources were told to stop at; Infinity while it is live. */
  endsAtCtx: number;
  /** Ctx time up to which this branch's pattern gain has a curve written; −Infinity when it has none. */
  patternEndCtx: number;
  /** Length of the audio this branch was built from, seconds. */
  durationSec: number;
  /**
   * Content-seconds consumed beyond nominal because `playbackRate !== 1` (B9e). Positive = this branch
   * has eaten *more* of the track than wall time says, i.e. it is further along.
   *
   * This bookkeeping is the whole cost of slewing, and it cannot be skipped: nothing in Web Audio reports
   * how much content a source has played. `startCtxForZero` is where track zero left the speaker *if the
   * rate were 1*, so once it is not, the effective value is `startCtxForZero − slewSec` and the drift
   * check has to use that or it would measure the correction as if it were still error, and never stop
   * correcting.
   */
  slewSec: number;
  /** The rate currently in effect (1 = nominal). */
  slewRate: number;
  /** Ctx time `slewSec` was last accrued to. */
  slewAtCtx: number;
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

/** delayMs − compensationMs: the assignment's share of this device's playhead shift, in ms. */
const timingShiftOf = (a: Assignment | null): number => (a?.delayMs ?? 0) - (a?.compensationMs ?? 0);

export class Scheduler {
  /** Master gain: local mute only, never part of the assignment. */
  private readonly master: GainLike;
  private buffers = new Map<string, BufferLike>();
  private durationSec = 0;
  private trackId: string | null = null;
  private branches: Branch[] = [];
  /**
   * Branches fading out under a crossfade. They are no longer "the music", but they are still sounding
   * for up to RESYNC_START_MARGIN_SEC + RESYNC_CROSSFADE_MS, and a stop that lands inside that window
   * has to silence them too — a seek 10 ms after a resync otherwise left the old position audible, at
   * full level, on top of the new one.
   */
  private retiring: Branch[] = [];
  private applied: AppliedKey | null = null;
  private assignment: Assignment | null = null;
  private patternTimer: ReturnType<typeof setInterval> | null = null;
  /** Serialized last pattern: ROOM_STATE arrives at 2 Hz and must not restart identical automation. */
  private patternKey: string | null = null;
  private muted = false;

  lastDecision: StartDecision | null = null;
  /** Last hard resync applied, ms. Feeds `syncErrMs`; keeps its value between resyncs. */
  lastCorrectionMs = 0;
  /** Most recent drift measurement, ms, corrected or not (diagnostics). */
  lastDriftErrorMs = 0;
  resyncCount = 0;
  /** Rate trim currently applied, ppm (B9e). 0 when slewing is off or inside the deadband. */
  lastSlewPpm = 0;
  /** B9e on/off. Defaults to the constant; `/diag` can flip it to compare against crossfade-only. */
  slewEnabled = PLAYBACK_RATE_SLEW_DEFAULT;
  /** Pattern curves Web Audio refused (diagnostics). Anything but 0 is a stretch of un-automated gain. */
  patternCurveRejections = 0;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private useOutputLatency = false;
  /** Last usable `ctx.outputLatency`, seconds — see `outputLatencySec()`. */
  private lastOutputLatencySec = 0;

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

  /**
   * Lets go of the decoded audio (a track change). Branches that are still sounding keep their own
   * reference through their source nodes, so the tail of the old song is unaffected.
   */
  /**
   * Ctx time at which the last branch that is fading or playing out (a hand-over tail, a crossfade)
   * stops sounding; 0 when there is none. Until then its buffers cannot be collected.
   */
  get tailEndsAtCtx(): number {
    let end = 0;
    for (const branch of this.retiring) if (Number.isFinite(branch.endsAtCtx)) end = Math.max(end, branch.endsAtCtx);
    return end;
  }

  get bufferCount(): number {
    return this.buffers.size;
  }

  clearBuffers(): void {
    this.buffers = new Map();
    this.trackId = null;
    this.durationSec = 0;
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
    const olSec = useOutputLatency ? this.outputLatencySec() : 0;
    return base + delaySec - compSec - olSec;
  }

  /**
   * `ctx.outputLatency`, held at its last usable value. Once this phone has reported a latency the
   * server stops sending a table guess for it, so the live value is the *only* compensation left: a read
   * of 0 (a context that has not rendered yet, a browser hiccup) would silently play ~40 ms late, and a
   * NaN would make every `start(when)` throw.
   */
  private outputLatencySec(): number {
    const live = this.deps.ctx.outputLatency;
    if (typeof live === "number" && Number.isFinite(live) && live > 0) this.lastOutputLatencySec = live;
    return this.lastOutputLatencySec;
  }

  /**
   * The whole shift of this device's playhead, ms: the assignment's delay and compensation *and* the
   * output latency the client subtracts itself when the server has no number for it. All three move the
   * audio, so all three belong in the "has the schedule changed?" comparison — see `apply`.
   */
  private netTimingShiftMs(a: Assignment | null, useOutputLatency: boolean): number {
    return timingShiftOf(a) - (useOutputLatency ? this.outputLatencySec() * 1000 : 0);
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
      if (wasPlaying || this.retiring.length > 0) this.stopAll("no assignment: this device is not a speaker");
      return { action: wasPlaying ? "stopped" : "idle", decision: null, reason: "assignment is null" };
    }

    if (transport.state !== "playing" || !opts.trackId || opts.trackId !== this.trackId || this.buffers.size === 0) {
      const wasPlaying = this.playing;
      // A paused or stopped room is silent, including a tail that was being allowed to play out. (A
      // track that is merely not loaded yet leaves that tail alone: that is the playlist advance.)
      const tailToSilence = transport.state !== "playing" && this.retiring.length > 0;
      if (wasPlaying || tailToSilence) this.stopAll("transport is not playing, or the track is not loaded");
      this.applied = null;
      return { action: wasPlaying ? "stopped" : "idle", decision: null, reason: transport.state };
    }

    const key: AppliedKey = {
      trackId: opts.trackId,
      transportState: "playing",
      serverTimeAtTrackZero: transport.serverTimeAtTrackZero,
      timingShiftMs: this.netTimingShiftMs(assignment, opts.useOutputLatency),
    };
    /*
     * A timing shift under RESYNC_THRESHOLD_MS is left to the drift check (B4) to absorb; a bigger one
     * is rescheduled now. This matters for WAVE: its delayMs is up to 300 ms, so switching into WAVE
     * mid-song has to move the playhead immediately or the mode does nothing audible.
     *
     * The shift compared is the *net* one. The server retires its table guess the first time a phone
     * reports `outputLatency`: one snapshot drops ~45 ms from compensationMs and flips useOutputLatency
     * on. Comparing compensation alone read that as a 45 ms move and stop-started the music on every
     * Android phone two seconds after it joined, when the playhead had really moved by the few ms
     * between the guess and the measurement.
     */
    const same =
      this.applied !== null &&
      this.applied.trackId === key.trackId &&
      this.applied.transportState === key.transportState &&
      this.applied.serverTimeAtTrackZero === key.serverTimeAtTrackZero &&
      Math.abs(this.applied.timingShiftMs - key.timingShiftMs) <= RESYNC_THRESHOLD_MS;

    /*
     * A buffer swap under a running branch (CHOIR: the pitched render finished, or the pitch was cleared).
     * `setBuffers` only replaces what the *next* branch is built from, so without this the phone kept
     * playing the old audio until something else — a seek, a pause — happened to rebuild the branch, and
     * CHOIR switched on mid-song did nothing audible at all. Once the music is sounding it is a crossfade
     * at the same position (the hard-resync path); a branch still waiting for its start instant is simply
     * rebuilt below, which is inaudible.
     */
    const live = this.branches.find((b) => !b.stopped);
    const swapped = same && live !== undefined && live.buffers !== this.buffers;
    const swapBeforeStart = swapped && this.deps.ctx.currentTime < live.startedAtCtx;

    if (same && this.playing && !swapBeforeStart) {
      // Gains and patterns may still have changed — that is a ramp, never a restart (B5e).
      this.applyAssignmentGains(assignment);
      if (swapped) {
        const decision = this.crossfadeToTimeline(assignment, opts.useOutputLatency);
        return { action: decision ? "restarted" : "unchanged", decision: this.lastDecision, reason: "buffers swapped" };
      }
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
    /*
     * A start that is still ahead — the server restarting the song on its own end, the next play from
     * the top — is a hand-over, not a cut: what is sounding runs up to the new start. Stopping it "now"
     * put LEAD_MS of silence in front of every loop the server had scheduled to be seamless, and took
     * the last 600 ms off every song.
     */
    if (restarted) this.stopAll("rescheduling", decision.mode === "scheduled" ? decision.whenCtx : undefined);
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
      buffers: this.buffers,
      sources: new Map(),
      stemGains: new Map(),
      patternGain,
      fadeGain,
      startCtxForZero: decision.startCtxForZero,
      startedAtCtx: decision.whenCtx,
      startOffsetSec: decision.offsetSec,
      stopped: false,
      endsAtCtx: Infinity,
      patternEndCtx: -Infinity,
      durationSec: this.durationSec,
      slewSec: 0,
      slewRate: 1,
      slewAtCtx: decision.whenCtx,
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
    /*
     * A new branch needs its own curve even when the pattern object is unchanged — `patternGain` starts at
     * 1, so an un-automated new branch plays at FULL level, which during STROBE's silent half is a loud
     * blip. The branch must be named explicitly: during a hard resync the old branch is still un-stopped
     * at this point (the crossfade needs it), so "the live branch" would find the one that is about to
     * fade out, and the fresh node would sit at 1 until the automation caught up — up to
     * PATTERN_LOOKAHEAD_MS of full-volume audio through the correction.
     */
    this.startPatternAutomation(assignment?.pattern ?? null, { restart: true, branch });
    return branch;
  }

  /**
   * Stops every branch with a short fade so a pause does not click.
   *
   * With `handoverCtx`, a branch that is already sounding is instead allowed to run until that instant
   * (or its own natural end, whichever is first) — provided that is no more than HANDOVER_MAX_SEC away.
   * It stops being "the music" at once: `playing` is false and the timers stop; it is only still audible.
   */
  stopAll(_reason = "stop", handoverCtx?: number): void {
    const pattern = this.assignment?.pattern ?? null;
    this.patternKey = null;
    const at = this.deps.ctx.currentTime;
    for (const branch of this.branches) {
      const naturalEnd = branch.startCtxForZero - branch.slewSec + branch.durationSec;
      const until = handoverCtx === undefined ? at : Math.min(handoverCtx, naturalEnd);
      const sounding = !branch.stopped && at >= branch.startedAtCtx;
      if (sounding && until > at + STOP_FADE_SEC && until - at <= HANDOVER_MAX_SEC) {
        // Its pattern has to be written out to the end now: the top-up timer is about to stop.
        if (pattern) this.writePatternWindow(pattern, branch, until + STOP_FADE_SEC);
        this.fadeOutAndStop(branch, until, STOP_FADE_SEC);
        this.retiring.push(branch);
      } else {
        this.fadeOutAndStop(branch, at, STOP_FADE_SEC);
      }
    }
    this.branches = [];
    if (handoverCtx === undefined) {
      for (const branch of this.retiring) this.cutShort(branch, at, STOP_FADE_SEC);
      this.retiring = [];
    } else {
      // A tail already waiting for an earlier hand-over must not outlast this one (the successor's
      // start just moved): two starts in a row would otherwise leave it playing over the second.
      this.retiring = this.retiring.filter((b) => b.endsAtCtx > at);
      for (const branch of this.retiring) this.cutShort(branch, Math.max(at, handoverCtx), STOP_FADE_SEC);
    }
    this.stopPatternAutomation();
    this.stopDriftCheck();
  }

  /** Ramps a branch's fade node to 0 and stops its sources after the fade. */
  private fadeOutAndStop(branch: Branch, at: number, fadeSec: number): void {
    if (branch.stopped) return;
    branch.stopped = true;
    branch.endsAtCtx = at + fadeSec;
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

  /** Brings an already-retiring branch's end forward to `at + fadeSec`, if it was going to outlast that. */
  private cutShort(branch: Branch, at: number, fadeSec: number): void {
    if (branch.endsAtCtx <= at + fadeSec) return;
    branch.endsAtCtx = at + fadeSec;
    branch.fadeGain.gain.cancelScheduledValues(at);
    branch.fadeGain.gain.setValueAtTime(branch.fadeGain.gain.value, at);
    branch.fadeGain.gain.linearRampToValueAtTime(0, at + fadeSec);
    for (const source of branch.sources.values()) {
      try {
        source.stop(at + fadeSec);
      } catch {
        /* an engine that refuses a second stop() keeps the first one, 70 ms away at most */
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
    this.accrueSlew(branch);
    const ideal = this.ctxTimeForTrackPosition(this.applied.serverTimeAtTrackZero, 0, assignment, useOutputLatency);
    // `− slewSec`: content already consumed by a rate trim has moved track zero earlier in effect.
    return (ideal - (branch.startCtxForZero - branch.slewSec)) * 1000;
  }

  /**
   * Integrate the rate trim into `slewSec` up to now. Idempotent (a second call in the same ctx instant
   * adds nothing), so it is safe to call from both the drift check and `driftErrorMs`.
   */
  private accrueSlew(branch: Branch): void {
    const ctxNow = this.deps.ctx.currentTime;
    const dt = ctxNow - branch.slewAtCtx;
    // Before the branch's start instant nothing is being consumed, at any rate: `slewAtCtx` begins at
    // the start time and must not be dragged back to "now", or the wait would be booked as playback.
    if (dt <= 0) return;
    branch.slewSec += (branch.slewRate - 1) * dt;
    branch.slewAtCtx = ctxNow;
  }

  /**
   * B9e. Trim `playbackRate` so a sub-threshold error converges instead of growing until it is worth a
   * crossfade. Proportional control, one measurement per `DRIFT_CHECK_INTERVAL_MS`:
   *
   *     ppm = clamp(−errorMs · 1000 / PLAYBACK_RATE_TAU_SEC, ±PLAYBACK_RATE_MAX_PPM)
   *
   * The 1000 converts ms of error into ppm-seconds: a trim of `r` ppm moves the playhead `r/1000` ms per
   * second, so nulling `e` ms over τ seconds needs `1000·e/τ` ppm. τ ≥ 2 check intervals keeps the loop
   * from overshooting (each tick removes at most half the measured error).
   *
   * The deadband matters more than the gain. `driftErrorMs` inherits the clock model's own noise, and the
   * applied offset is itself slewing at up to 2 ms/s, so chasing tenths of a millisecond would mean a
   * permanently non-unity rate reacting to nothing. Inside the deadband the rate returns to exactly 1.
   */
  private applySlew(branch: Branch, errorMs: number): number {
    if (!this.slewEnabled) return 0;
    const ppm =
      Math.abs(errorMs) < PLAYBACK_RATE_DEADBAND_MS
        ? 0
        : Math.max(
            -PLAYBACK_RATE_MAX_PPM,
            Math.min(PLAYBACK_RATE_MAX_PPM, (-errorMs * 1000) / PLAYBACK_RATE_TAU_SEC),
          );
    const rate = 1 + ppm / 1_000_000;
    if (rate === branch.slewRate) return ppm;
    const ctxNow = this.deps.ctx.currentTime;
    this.accrueSlew(branch); // close the books on the old rate before the new one takes effect
    for (const source of branch.sources.values()) {
      // A step, not a ramp: 500 ppm is 0.87 cents, and a ramp would make the integral above a guess.
      source.playbackRate?.setValueAtTime(rate, ctxNow);
    }
    branch.slewRate = rate;
    return ppm;
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
    const live = this.branches.find((b) => !b.stopped);
    /*
     * A branch still waiting for its start instant (the 5 s lead of a playlist advance, mostly). Neither
     * tool below works on it: a crossfade has nothing to fade from and was refused ("outside the track"),
     * so an error that appeared during the wait — the clock stepped, the output route changed — was
     * carried into the first second of the song; and a rate trim was applied to a source that was not
     * playing, then booked as content consumed. Moving a start that has not happened is free and exact,
     * so do that instead. (A start closer than the resync margin is left to the paths below: it is as
     * good as playing, and too near to re-place reliably.)
     */
    if (live && live.startedAtCtx - this.deps.ctx.currentTime > RESYNC_START_MARGIN_SEC) {
      if (Math.abs(errorMs) > PLAYBACK_RATE_DEADBAND_MS) this.rebuildBeforeStart(assignment, useOutputLatency);
      return { errorMs, resynced: false };
    }
    if (Math.abs(errorMs) <= RESYNC_THRESHOLD_MS) {
      // B9e: absorb it by rate instead of letting it grow into a crossfade.
      if (live) this.lastSlewPpm = this.applySlew(live, errorMs);
      return { errorMs, resynced: false };
    }

    // The correction would land outside the track: nothing useful to fade to.
    if (!this.crossfadeToTimeline(assignment, useOutputLatency)) return { errorMs, resynced: false };
    this.lastCorrectionMs = errorMs;
    this.resyncCount++;
    return { errorMs, resynced: true };
  }

  /** Re-places a branch that has not sounded yet on the start time the timeline gives now. */
  private rebuildBeforeStart(assignment: Assignment | null, useOutputLatency: boolean): void {
    if (this.applied === null) return;
    const ctxNow = this.deps.ctx.currentTime;
    const startCtxForZero = this.ctxTimeForTrackPosition(this.applied.serverTimeAtTrackZero, 0, assignment, useOutputLatency);
    const decision = decideStart({ ctxNow, startCtxForZero, durationSec: this.durationSec });
    for (const branch of this.branches) this.fadeOutAndStop(branch, ctxNow, 0); // stops before it ever starts
    this.branches = [];
    if (!decision) return this.stopAll("past the end of the track");
    // …and a tail that was waiting for the old start instant follows the new one if it is earlier.
    for (const branch of this.retiring) this.cutShort(branch, decision.whenCtx, STOP_FADE_SEC);
    this.applied = { ...this.applied, timingShiftMs: this.netTimingShiftMs(assignment, useOutputLatency) };
    this.startBranch(decision, assignment);
    this.lastDecision = decision;
    this.lastSlewPpm = 0;
  }

  /**
   * Replaces the live branch with a fresh one at the position the timeline says is playing right now,
   * crossfading over RESYNC_CROSSFADE_MS. Shared by the hard resync (same audio, corrected position) and
   * a buffer swap (same position, different audio). Returns null — and changes nothing — when "now" is
   * outside the track.
   */
  private crossfadeToTimeline(assignment: Assignment | null, useOutputLatency: boolean): StartDecision | null {
    if (this.applied === null) return null;
    const ctxNow = this.deps.ctx.currentTime;
    const startCtxForZero = this.ctxTimeForTrackPosition(this.applied.serverTimeAtTrackZero, 0, assignment, useOutputLatency);
    const whenCtx = ctxNow + RESYNC_START_MARGIN_SEC;
    const offsetSec = whenCtx - startCtxForZero;
    if (offsetSec < 0 || offsetSec >= this.durationSec) return null;
    const decision: StartDecision = { whenCtx, offsetSec, startCtxForZero, mode: "immediate" };
    const fadeSec = RESYNC_CROSSFADE_MS / 1000;
    const old = this.branches.filter((b) => !b.stopped);

    const fresh = this.startBranch(decision, assignment, 0);
    fresh.fadeGain.gain.setValueAtTime(0, whenCtx);
    fresh.fadeGain.gain.linearRampToValueAtTime(1, whenCtx + fadeSec);
    for (const branch of old) this.fadeOutAndStop(branch, whenCtx, fadeSec);
    this.branches = this.branches.filter((b) => !b.stopped);
    this.retiring = [...this.retiring.filter((b) => b.endsAtCtx > ctxNow), ...old];

    this.lastDecision = decision;
    // The branch now embodies today's shift (a Bluetooth route that added 150 ms of output latency was
    // just corrected for); without this the next snapshot would see a "change" and restart it again.
    this.applied = { ...this.applied, timingShiftMs: this.netTimingShiftMs(assignment, useOutputLatency) };
    // The fresh branch starts at rate 1: the step it was just given is the correction, so any trim
    // carried over would be applied twice.
    this.lastSlewPpm = 0;
    return decision;
  }

  private startDriftCheck(): void {
    if (this.driftTimer) return;
    let lastCtx = this.deps.ctx.currentTime;
    let lastLocalMs = this.deps.now();
    this.driftTimer = setInterval(() => {
      if (!this.playing) return this.stopDriftCheck();
      const ctxNow = this.deps.ctx.currentTime;
      const localMs = this.deps.now();
      const advancedSec = ctxNow - lastCtx;
      const elapsedSec = (localMs - lastLocalMs) / 1000;
      lastCtx = ctxNow;
      lastLocalMs = localMs;
      /*
       * Stand down while the audio clock is not running — a suspended or interrupted context, or the
       * iOS zombie that says 'running' with a frozen clock. Nothing can be corrected by scheduling on a
       * clock that is not moving, and trying is actively harmful: the measured error grows by a second
       * every second, so each tick "hard-resynced", building a new branch at `currentTime + 50 ms` — the
       * same frozen instant every time. A one-minute interruption left sixty branches queued on that
       * instant, and when the context came back they all started at once, at sixty different positions.
       * The engine re-checks the moment the context reports running; this loop picks up from there.
       */
      const state = this.deps.ctx.state;
      if (state !== undefined && state !== "running") return;
      if (elapsedSec > 0 && advancedSec < elapsedSec * AUDIO_CLOCK_STALLED_RATIO) return;
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
  private startPatternAutomation(
    pattern: Pattern | null,
    opts: { restart?: boolean; branch?: Branch } = {},
  ): void {
    const key = pattern ? JSON.stringify(pattern) : null;
    const changed = key !== this.patternKey;
    if (!changed && !opts.restart) return;
    this.patternKey = key;
    const ctxNow = this.deps.ctx.currentTime;
    if (!pattern) {
      this.stopPatternAutomation();
      for (const branch of this.branches) {
        if (branch.stopped) continue;
        branch.patternGain.gain.cancelScheduledValues(ctxNow);
        branch.patternGain.gain.setTargetAtTime(1, ctxNow, GAIN_RAMP_TC_SEC);
        branch.patternEndCtx = -Infinity;
      }
      return;
    }
    if (changed) {
      // A different pattern: what the old one wrote ahead has to go first, or its curves are still
      // sitting where the new ones belong and Web Audio refuses every one of them.
      for (const branch of this.branches) {
        if (branch.stopped || branch === opts.branch) continue;
        branch.patternGain.gain.cancelScheduledValues(ctxNow);
        branch.patternEndCtx = -Infinity;
      }
    }
    this.writePatternWindow(pattern, opts.branch);
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
  }

  /**
   * Tops the pattern curve up to PATTERN_LOOKAHEAD_MS ahead of the playhead — and no further.
   *
   * The horizon is the point. This used to write a fixed 200 ms on every 100 ms tick, each starting where
   * the last ended, so the written curve ran ahead of the music at twice real time: a minute into a song,
   * a minute of the *current* pattern was already scheduled. A change of pattern then had nowhere to go —
   * every new curve overlapped an old one, Web Audio refused it (the throw was swallowed below), and the
   * phone kept strobing to the old pattern for as long as the song had been playing.
   *
   * The window is laid out in ctx time, from where the previous curve ended:
   *  - never in the past (a late tick, a throttled tab) and never before the branch's own start (a
   *    scheduled start still ahead: the first window then begins at track position 0);
   *  - PATTERN_CURVE_GAP_SEC clear of the previous curve, because two curves that merely touch are
   *    "overlapping" whenever float rounding lands the wrong way, which in Chrome was one window in nine;
   *  - evaluated at the track position that will actually be sounding at each instant, so the curve
   *    stays aligned to the music rather than to the moment the tick happened to run.
   */
  private writePatternWindow(pattern: Pattern, target?: Branch, untilCtx?: number): void {
    const branch = target ?? this.branches.find((b) => !b.stopped);
    if (!branch || branch.stopped) return;
    const origin = Math.max(this.deps.ctx.currentTime, branch.startedAtCtx);
    const startCtx = Math.max(origin, branch.patternEndCtx + PATTERN_CURVE_GAP_SEC);
    // `untilCtx`: write out to a fixed instant instead of the usual horizon (a branch being handed over).
    const durationSec = (untilCtx ?? origin + PATTERN_LOOKAHEAD_MS / 1000) - startCtx;
    if (durationSec < PATTERN_MIN_WINDOW_SEC) return; // already written far enough ahead

    const fromMs = (branch.startOffsetSec + (startCtx - branch.startedAtCtx)) * 1000;
    const points = Math.max(2, Math.round(durationSec * PATTERN_CURVE_HZ) + 1);
    const curve = new Float32Array(points);
    for (let i = 0; i < points; i++) {
      curve[i] = evaluatePattern(pattern, fromMs + (durationSec * 1000 * i) / (points - 1));
    }
    try {
      branch.patternGain.gain.setValueCurveAtTime(curve, startCtx, durationSec);
      branch.patternEndCtx = startCtx + durationSec;
    } catch {
      // Refused (an engine with its own idea of what overlaps). `patternEndCtx` is left alone, so the
      // next tick tries again from "now" instead of skipping the window; the count makes it visible.
      this.patternCurveRejections++;
    }
  }

  dispose(): void {
    this.stopAll("dispose");
    this.stopPatternAutomation();
    this.stopDriftCheck();
    this.master.disconnect();
  }
}
