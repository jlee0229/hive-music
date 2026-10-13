/**
 * The clock: NTP-style offset estimation over the room WebSocket, plus the serverTime → AudioContext
 * mapping every scheduling decision goes through. Algorithms and sign conventions: docs/03-sync-engine.md.
 *
 * Three mechanisms, each earning its place in the ±2–5 ms clock budget:
 *
 * 1. **Min-RTT selection** over a sliding window of NTP_WINDOW accepted samples. For a probe whose
 *    one-way delays are d1 (up) and d2 (down), `offset = trueOffset + (d1 − d2)/2` and `rtt = d1 + d2`.
 *    The smallest RTT in the window is the sample where both delays were small, so its asymmetry — the
 *    whole error — is small too. Averaging would mix in every queued packet instead.
 *
 * 2. **Coded probe pairs.** Two probes leave NTP_PROBE_PAIR_GAP_MS apart sharing a probeGroupId. The
 *    server echoes its own receive stamps, so the client can compare the inter-departure gap it created
 *    with the inter-arrival gap the server saw. A queueing event on the way up stretches one and not the
 *    other; if they differ by more than NTP_PROBE_PAIR_TOLERANCE_MS both samples are dropped. This is the
 *    only mechanism here that can detect *asymmetric* delay, which min-RTT alone cannot: a probe that was
 *    delayed by exactly the same amount in both directions has a perfectly normal RTT and a wrong offset.
 *
 * 3. **Slewed application.** After the first estimate (adopted directly — there is nothing to slew from)
 *    the applied offset moves toward the estimate at SLEW_RATE_MS_PER_SEC, so audio never hears a step.
 *    An error above RESYNC_THRESHOLD_MS is a real jump (route change, a resumed tab) and is applied at
 *    once: the alternative is minutes of audible drift.
 */
import {
  NTP_PROBE_PAIR_GAP_MS, NTP_PROBE_PAIR_TOLERANCE_MS, NTP_SAMPLE_MAX_AGE_MS, NTP_WINDOW, NTP_BURST_WINDOW_MS,
  RESYNC_THRESHOLD_MS, SYNC_FLOOR_MS,
} from "@hive/protocol";

/** Applied-offset slew rate, ms per second (docs/03-sync-engine.md, "Application"). */
export const SLEW_RATE_MS_PER_SEC = 2;
/** How many (localNow, ctx.currentTime) pairs the mapping keeps. */
export const CTX_SAMPLE_WINDOW = 10;
/** A half-arrived pair older than this is forgotten (its partner was lost). */
const PAIR_TTL_MS = 5000;
/**
 * Allowance, ms, when testing two samples for contradiction (see `dropContradicted`): what an honest
 * local clock can drift against the server across the 30 s window (100 ppm is 3 ms) plus stamp noise.
 */
export const CONSISTENCY_SLACK_MS = 5;

export const localNow = (): number =>
  typeof performance !== "undefined" ? performance.timeOrigin + performance.now() : Date.now();

export interface Probe {
  /** client send (local clock) */
  t0: number;
  /** server receive */
  t1: number;
  /** server send */
  t2: number;
  /** client receive (local clock) */
  t3: number;
  probeGroupId?: number;
  probeGroupIndex?: 0 | 1;
}

export type ProbeVerdict = "accepted" | "buffered" | "rejected";

/**
 * Which estimator turns probes into an offset.
 *
 *  - `"floor"` — what the engine runs. Every probe is kept for NTP_SAMPLE_MAX_AGE_MS; the estimate is
 *    the sample with the smallest error *bound* (`rtt/2` plus what the crystal can have drifted since);
 *    and the path's RTT floor is remembered, so that when nothing in the window is near it — sustained
 *    one-way congestion, the one thing a round trip cannot tell from a clock change — the offset is
 *    held instead of followed.
 *  - `"pairs"` — the previous estimator: only coded pairs whose two halves saw the same uplink delay
 *    (within 2 ms) enter a 30-sample window. Kept for A/B on /diag: on a jittery link it discards
 *    66–89 % of probes, so the first clock takes seconds and the sparse window lets a response that sat
 *    behind a retransmit become "the best" (measured by scale-net, SCALE-NET-06).
 *  - `"plain"` — every probe into the 30-sample min-RTT window, no gating: `createStubClient`.
 */
export type ClockEstimator = "floor" | "pairs" | "plain";

export interface ClockModelOptions {
  /** Shorthand kept for existing callers: `true` is `estimator: "pairs"`, `false` is `"plain"`. */
  pairs?: boolean;
  estimator?: ClockEstimator;
}

/** The clock the real engine runs. Tests and simulators build theirs through this too. */
export const createEngineClock = (): ClockModel => new ClockModel({ estimator: "floor" });

/** `"floor"`: crystal drift assumed when ranking an old sample against a new one, parts per million. */
export const FLOOR_AGE_PPM = 50;
/**
 * `"floor"`: how long the offset is held when nothing in the window is near the RTT floor, before
 * concluding that the path itself got longer and relearning the floor. At 50 ppm that is 3 ms of coast.
 */
export const FLOOR_HOLD_MS = 60_000;
/** `"floor"`: a sample counts as "at the floor" within this fraction of it (and never less than 2 ms). */
export const FLOOR_NEAR_FRACTION = 0.25;
/**
 * `"floor"`: the first estimate is adopted as soon as some sample bounds the error to this (its RTT is
 * at most twice it) — the first or second probe on a good link. Otherwise the model waits for
 * FLOOR_FIRST_MIN_PROBES (one second into the burst) and takes the best of them.
 *
 * Half the 30 ms floor, chosen on scale-net's links (40 seeds each): at 30 ms a phone has a clock
 * 0.5 s sooner on venue Wi-Fi but is up to 18 ms wrong in its first seconds; at 10 ms the worst venue
 * phone waits 2.2 s; at 15 ms the worst first clock is 1.35 s and the worst early error 13.8 ms. Fewer
 * than ten probes for the fallback is not enough on a link with retransmits (six: 93 ms).
 */
export const FLOOR_FIRST_BOUND_MS = SYNC_FLOOR_MS / 2;
export const FLOOR_FIRST_MIN_PROBES = 10;
/** `"floor"`: hard cap on the window (the burst is 40 probes in 4 s, steady state 2 a second). */
const FLOOR_MAX_SAMPLES = 160;

interface Sample {
  offset: number;
  rtt: number;
  /** Local time the sample completed (`t3`), so the window can drop it by age as well as by count. */
  at: number;
}

export class ClockModel {
  /** Applied offset (serverTime − localTime), ms. What `SyncStatus.clockOffsetMs` reports. */
  offsetMs: number | null = null;
  /** Raw min-RTT estimate before slewing; the applied offset chases this. */
  estimateOffsetMs: number | null = null;
  /** Best (minimum) round-trip in the window, ms. */
  rttMs: number | null = null;
  /** Last correction applied to the offset, ms (diagnostics; a step shows up here in full). */
  lastStepMs = 0;
  accepted = 0;
  rejected = 0;
  /** Halves of failed pairs taken anyway because their RTT beat the window's best (diagnostics). */
  rescued = 0;
  /** Times a new sample proved older ones wrong and they were dropped — a clock step was seen (diagnostics). */
  stepsDetected = 0;
  /**
   * True when pair validation had to be relaxed because nothing was accepted within the first burst
   * window. A phone with no clock cannot play at all, so a degraded clock beats no clock — surfaced
   * here so /diag can say so.
   */
  degraded = false;

  /** `"floor"` only: true while the offset is being held because nothing in the window is near the RTT floor. */
  holding = false;
  /** `"floor"` only: the path's round-trip floor as currently believed, ms. */
  floorRttMs: number | null = null;
  readonly estimator: ClockEstimator;

  private readonly usePairs: boolean;
  private samples: Sample[] = [];
  private pending = new Map<number, Probe>();
  private firstProbeLocal: number | null = null;
  private lastSlewLocal = 0;
  private lastNearFloorAt = -Infinity;

  constructor(opts: ClockModelOptions = {}) {
    this.estimator = opts.estimator ?? (opts.pairs ? "pairs" : "plain");
    this.usePairs = this.estimator === "pairs";
  }

  /**
   * Feeds one probe. The 4-argument form (what `createStubClient` uses) is unpaired and accepted
   * immediately; passing the group id and index turns on pair validation when the model was
   * constructed with `pairs: true`.
   */
  addProbe(t0: number, t1: number, t2: number, t3: number, probeGroupId?: number, probeGroupIndex?: 0 | 1): ProbeVerdict {
    const probe: Probe = { t0, t1, t2, t3, probeGroupId, probeGroupIndex };
    this.firstProbeLocal ??= t3;
    if (this.estimator === "floor") return this.addProbeFloor(probe);

    if (!this.usePairs || probeGroupId === undefined || probeGroupIndex === undefined) {
      this.accept(probe);
      return "accepted";
    }

    this.prunePending(t3);
    const partner = this.pending.get(probeGroupId);
    if (!partner) {
      this.pending.set(probeGroupId, probe);
      return "buffered";
    }
    this.pending.delete(probeGroupId);

    const [first, second] = partner.probeGroupIndex === 0 ? [partner, probe] : [probe, partner];
    // The gap we created vs. the gap the server measured. NTP_PROBE_PAIR_GAP_MS is what we aimed for;
    // what matters is that the *sent* and *received* gaps agree, so scheduler slop cancels out.
    const sentGap = second.t0 - first.t0;
    const seenGap = second.t1 - first.t1;
    if (Math.abs(seenGap - sentGap) > NTP_PROBE_PAIR_TOLERANCE_MS) {
      this.rejected += 2;
      /*
       * A failed pair is not always worthless. The error of any sample is bounded by its round trip
       * (|error| ≤ rtt/2 less the path floor), so a half whose RTT beats the best sample in the window
       * has a *tighter* bound than the one the clock is running on, whatever the pair test thought of
       * its neighbour. On a jittery cellular link nine pairs in ten fail the 2 ms test; discarding them
       * all starved min-RTT selection of exactly the samples it exists to find.
       *
       * The same arithmetic makes a failed half admissible as a *witness*: if its interval cannot overlap
       * the one the clock is running on, the offset has moved (see `dropContradicted`), and waiting for a
       * pair that passes — one in ten, here — means playing the whole step out of sync meanwhile.
       */
      if (this.samples.length > 0 && this.rttMs !== null && this.estimateOffsetMs !== null) {
        const better = rttOf(first) <= rttOf(second) ? first : second;
        const contradicts =
          Math.abs(offsetOf(better) - this.estimateOffsetMs) > (rttOf(better) + this.rttMs) / 2 + CONSISTENCY_SLACK_MS;
        if (rttOf(better) < this.rttMs || contradicts) {
          this.rescued++;
          this.accept(better);
          return "accepted";
        }
      }
      // Fallback: if the path is so jittery that nothing has been accepted by the end of the burst
      // window, take the better half of the pair rather than leave the phone with no clock.
      if (this.samples.length === 0 && this.firstProbeLocal !== null && t3 - this.firstProbeLocal > NTP_BURST_WINDOW_MS) {
        this.degraded = true;
        const better = rttOf(first) <= rttOf(second) ? first : second;
        this.accept(better);
        return "accepted";
      }
      return "rejected";
    }
    this.accept(first);
    this.accept(second);
    return "accepted";
  }

  /** The inter-departure gap a caller should aim for when sending the second probe of a pair. */
  static get pairGapMs(): number {
    return NTP_PROBE_PAIR_GAP_MS;
  }

  /**
   * The `"floor"` estimator (see ClockEstimator). Three rules, each there for a measured reason:
   *
   *  1. **Keep every probe.** A sample's error is bounded by half its round trip whatever its neighbour
   *     did, so nothing is thrown away for failing a jitter test; the window is dense, and "the best
   *     sample in it" is never a response that happened to sit behind a retransmit.
   *  2. **Rank by bound, not by RTT**: `rtt/2 + FLOOR_AGE_PPM × age`. An old sample is a stale sample
   *     once the crystal has drifted under it.
   *  3. **Hold over.** Every sample in a congested window is biased the same way (a 40 s upload on the
   *     same Wi-Fi drags the clock ~20 ms), and their RTTs say so: none is near the floor. The offset
   *     is then held — it was right a moment ago and a crystal moves 3 ms a minute — until a sample at
   *     the floor returns, or FLOOR_HOLD_MS passes and the longer path is accepted as the new floor.
   *
   * A sample that *contradicts* what is held (intervals that cannot overlap: the clock itself moved)
   * overrides the hold-over at once — see `dropContradicted`.
   */
  private addProbeFloor(p: Probe): ProbeVerdict {
    const t3 = p.t3;
    const fresh: Sample = { offset: offsetOf(p), rtt: rttOf(p), at: t3 };
    const before = this.samples.length;
    this.dropContradicted(fresh);
    const stepped = this.samples.length < before;
    this.samples.push(fresh);
    this.samples = this.samples.filter((s) => t3 - s.at <= NTP_SAMPLE_MAX_AGE_MS);
    if (this.samples.length === 0) this.samples = [fresh];
    if (this.samples.length > FLOOR_MAX_SAMPLES) this.samples.splice(0, this.samples.length - FLOOR_MAX_SAMPLES);
    this.accepted++;

    const ppm = FLOOR_AGE_PPM / 1e6;
    const bound = (s: Sample): number => s.rtt / 2 + ppm * (t3 - s.at);
    const best = this.samples.reduce((a, b) => (bound(b) < bound(a) ? b : a));

    if (this.offsetMs === null) {
      // No clock yet. Take the first sample that pins the error to FLOOR_FIRST_BOUND_MS; failing that,
      // the best of the first FLOOR_FIRST_MIN_PROBES (one second into the burst), which on a path whose
      // floor is that long is as good as it gets. `degraded` says the bound was not met.
      const bounded = best.rtt / 2 <= FLOOR_FIRST_BOUND_MS;
      const waitedOut =
        this.samples.length >= FLOOR_FIRST_MIN_PROBES ||
        (this.firstProbeLocal !== null && t3 - this.firstProbeLocal > NTP_BURST_WINDOW_MS);
      if (!bounded && !waitedOut) return "buffered";
      this.degraded = !bounded;
      this.floorRttMs = Math.min(...this.samples.map((s) => s.rtt));
      this.lastNearFloorAt = t3;
    } else {
      this.floorRttMs = Math.min(this.floorRttMs ?? Infinity, fresh.rtt);
      const nearFloor = best.rtt <= this.floorRttMs + Math.max(2, FLOOR_NEAR_FRACTION * this.floorRttMs);
      if (nearFloor || stepped) {
        this.lastNearFloorAt = t3;
        this.holding = false;
      } else if (t3 - this.lastNearFloorAt < FLOOR_HOLD_MS) {
        // Hold-over: keep the estimate, keep slewing the applied offset towards it.
        this.holding = true;
        this.applySlew(t3);
        return "accepted";
      } else {
        // Nothing near the old floor for a whole hold period: the path got longer. Relearn it.
        this.floorRttMs = best.rtt;
        this.lastNearFloorAt = t3;
        this.holding = false;
      }
      if (this.degraded && best.rtt / 2 <= FLOOR_FIRST_BOUND_MS) this.degraded = false;
    }
    this.estimateOffsetMs = best.offset;
    this.rttMs = best.rtt;
    this.applySlew(t3);
    return "accepted";
  }

  private accept(p: Probe): void {
    this.accepted++;
    const fresh: Sample = { offset: offsetOf(p), rtt: rttOf(p), at: p.t3 };
    this.dropContradicted(fresh);
    this.samples.push(fresh);
    if (this.samples.length > NTP_WINDOW) this.samples.shift();
    /*
     * Age matters as much as count, and min-RTT selection does not know that. One lucky low-RTT sample
     * wins the `reduce` below until it is shifted out — but an *offset* goes stale on its own: the local
     * clock drifts against the server at tens of ppm, so a sample from before a resumed tab, a reconnect
     * or a server restart can pin this phone tens of ms wrong while reporting a 2 ms RTT and a healthy
     * `syncErrMs`. Probing is 1 Hz in steady state, so this prunes nothing in normal operation; it only
     * bites after a gap, which is exactly where the stale sample comes from. The last sample is always
     * kept: a phone with no clock cannot play at all.
     */
    if (this.samples.length > 1) {
      const fresh = this.samples.filter((s) => p.t3 - s.at <= NTP_SAMPLE_MAX_AGE_MS);
      this.samples = fresh.length > 0 ? fresh : [this.samples[this.samples.length - 1]!];
    }
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.estimateOffsetMs = best.offset;
    this.rttMs = best.rtt;
    this.applySlew(p.t3);
  }

  /**
   * Drops every held sample the new one contradicts.
   *
   * A sample pins the true offset inside `offset ± rtt/2` — that is arithmetic, not statistics (both
   * one-way delays are ≥ 0). So two samples whose intervals do not overlap cannot both describe the same
   * clock: the offset *moved* between them, and the older one describes a clock that no longer exists.
   * That is a phone whose `performance.now()` stood still while it slept, an NTP step on the server, a
   * room that came back on another machine.
   *
   * Min-RTT selection cannot see this — it has no notion of time — and the age limit does not help when
   * the local clock is the thing that stopped: a low-RTT sample from before the step kept winning until
   * 30 newer ones had pushed it out, and for those 15–20 s the phone played the full step out of sync
   * while reporting a 2 ms RTT.
   */
  private dropContradicted(fresh: Sample): void {
    const before = this.samples.length;
    if (before === 0) return;
    this.samples = this.samples.filter(
      (s) => Math.abs(s.offset - fresh.offset) <= (s.rtt + fresh.rtt) / 2 + CONSISTENCY_SLACK_MS,
    );
    if (this.samples.length < before) this.stepsDetected++;
  }

  private prunePending(now: number): void {
    for (const [id, p] of this.pending) if (now - p.t3 > PAIR_TTL_MS) this.pending.delete(id);
  }

  /**
   * Moves the applied offset toward the estimate. Call it from `accept` (every probe) — and nowhere
   * else, because time passing without new information is not a reason to move the clock.
   */
  private applySlew(atLocal: number): void {
    const est = this.estimateOffsetMs;
    if (est == null) return;
    if (this.offsetMs == null) {
      this.offsetMs = est; // first estimate: adopted directly, there is nothing to slew from
      this.lastStepMs = 0;
      this.lastSlewLocal = atLocal;
      return;
    }
    const dtSec = Math.max(0, (atLocal - this.lastSlewLocal) / 1000);
    this.lastSlewLocal = atLocal;
    const err = est - this.offsetMs;
    if (Math.abs(err) > RESYNC_THRESHOLD_MS) {
      this.offsetMs = est; // a real jump: apply it now and let the drift check resync the audio
      this.lastStepMs = err;
      return;
    }
    const step = Math.sign(err) * Math.min(Math.abs(err), SLEW_RATE_MS_PER_SEC * dtSec);
    this.offsetMs += step;
    this.lastStepMs = step;
  }

  /** Estimated server time now, ms. Safe to call at 60 fps. */
  serverNow(at: number = localNow()): number {
    return at + (this.offsetMs ?? 0);
  }

  /** Local time at which a given server time occurs. */
  localTimeFor(serverTime: number): number {
    return serverTime - (this.offsetMs ?? 0);
  }

  /** Reconnect: keep the applied offset and the window, restart the burst (docs/03). */
  onReconnect(): void {
    this.pending.clear();
  }
}

const rttOf = (p: Probe): number => p.t3 - p.t0 - (p.t2 - p.t1);
const offsetOf = (p: Probe): number => (p.t1 - p.t0 + (p.t2 - p.t3)) / 2;

/**
 * serverTime ↔ AudioContext time. Sampled in the same synchronous tick as each probe so a server time
 * maps to a ctx time through ONE relation instead of two (local→server and local→ctx would each carry
 * their own error).
 *
 * `localToCtxSec` is a median, not a mean: `ctx.currentTime` is quantised to the render quantum and a
 * tab that was throttled produces occasional outliers, both of which a mean would smear into the
 * mapping and a median ignores.
 */
export class CtxMapper {
  private samples: Array<{ local: number; ctx: number }> = [];

  constructor(private readonly clock: ClockModel) {}

  /** Call with `localNow()` and `ctx.currentTime` read in the same tick. */
  addSample(local: number, ctx: number): void {
    this.samples.push({ local, ctx });
    if (this.samples.length > CTX_SAMPLE_WINDOW) this.samples.shift();
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Forgets every sample. The relation between the local clock and `ctx.currentTime` is only constant
   * while one context runs uninterrupted: a suspension stops ctx time while local time carries on, and a
   * rebuilt context counts from zero. Samples from before either describe a mapping that no longer
   * exists, and the median would keep answering with it until six newer ones had arrived.
   */
  reset(): void {
    this.samples = [];
  }

  /** median(ctx − local/1000), seconds; null before the first sample. */
  get localToCtxSec(): number | null {
    if (this.samples.length === 0) return null;
    const deltas = this.samples.map((s) => s.ctx - s.local / 1000).sort((a, b) => a - b);
    const mid = deltas.length >> 1;
    return deltas.length % 2 ? deltas[mid]! : (deltas[mid - 1]! + deltas[mid]!) / 2;
  }

  /**
   * The public `clock.ctxTimeFor(S)`: the plain mapping, with no compensation and no delay — the
   * scheduler applies those itself. Used by the drift check, by calibration stamps and by the UI.
   */
  ctxTimeFor(serverTime: number): number {
    const base = this.localToCtxSec;
    if (base == null) return 0;
    return base + this.clock.localTimeFor(serverTime) / 1000;
  }

  /**
   * The one-tick form: identical to `ctxTimeFor` when `ctxNow` was read in this tick, but immune to a
   * stale mapping. This is what `source.start(when)` is computed from.
   */
  ctxTimeForNow(serverTime: number, ctxNow: number, at: number = localNow()): number {
    return ctxNow + (serverTime - this.clock.serverNow(at)) / 1000;
  }

  /**
   * Inverse of `ctxTimeFor`: the server time at which a given ctx time occurs. This is how a test (or
   * the rig) converts "when this phone will emit track position 0" back into the shared clock, which is
   * the only frame in which two phones can be compared.
   */
  serverTimeForCtx(ctxTime: number): number | null {
    const base = this.localToCtxSec;
    if (base == null) return null;
    return (ctxTime - base) * 1000 + (this.clock.offsetMs ?? 0);
  }
}
