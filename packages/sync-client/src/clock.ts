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
  RESYNC_THRESHOLD_MS,
} from "@hive/protocol";

/** Applied-offset slew rate, ms per second (docs/03-sync-engine.md, "Application"). */
export const SLEW_RATE_MS_PER_SEC = 2;
/** How many (localNow, ctx.currentTime) pairs the mapping keeps. */
export const CTX_SAMPLE_WINDOW = 10;
/** A half-arrived pair older than this is forgotten (its partner was lost). */
const PAIR_TTL_MS = 5000;

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

export interface ClockModelOptions {
  /**
   * Enforce coded-pair validation. On for the real engine; off for `createStubClient`, which has no
   * audio to protect and must stay deterministic in CI.
   */
  pairs?: boolean;
}

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
  /**
   * True when pair validation had to be relaxed because nothing was accepted within the first burst
   * window. A phone with no clock cannot play at all, so a degraded clock beats no clock — surfaced
   * here so /diag can say so.
   */
  degraded = false;

  private readonly usePairs: boolean;
  private samples: Sample[] = [];
  private pending = new Map<number, Probe>();
  private firstProbeLocal: number | null = null;
  private lastSlewLocal = 0;

  constructor(opts: ClockModelOptions = {}) {
    this.usePairs = opts.pairs ?? false;
  }

  /**
   * Feeds one probe. The 4-argument form (what `createStubClient` uses) is unpaired and accepted
   * immediately; passing the group id and index turns on pair validation when the model was
   * constructed with `pairs: true`.
   */
  addProbe(t0: number, t1: number, t2: number, t3: number, probeGroupId?: number, probeGroupIndex?: 0 | 1): ProbeVerdict {
    const probe: Probe = { t0, t1, t2, t3, probeGroupId, probeGroupIndex };
    this.firstProbeLocal ??= t3;

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

  private accept(p: Probe): void {
    this.accepted++;
    this.samples.push({ offset: (p.t1 - p.t0 + (p.t2 - p.t3)) / 2, rtt: rttOf(p), at: p.t3 });
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
