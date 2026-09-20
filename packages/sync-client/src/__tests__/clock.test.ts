/**
 * B2: the clock model against a fake transport. No network, no audio — the gate's numbers are
 * +137 ms true offset, ±30 ms jitter, 20 % spikes of +80 ms, coded-pair rejection on, and an offset
 * error under 2 ms after 30 probes.
 *
 * The jitter model matters as much as the numbers. IID per-packet jitter would be the easy case and
 * would not resemble a room full of phones on one access point: real delay is a *path state* that holds
 * for a while, plus individual packets that get queued. So each probe pair draws a shared base delay
 * (the path state, U(0,30) — the ±30 ms) and each packet gets small independent noise, and 20 % of
 * packets are hit by an +80 ms queueing spike. That is exactly the shape coded pairs are designed to
 * detect: a spike lands on one member of a pair and stretches the gap the server observes.
 */
import { describe, expect, test } from "bun:test";
import { NTP_BURST_COUNT, NTP_PROBE_PAIR_GAP_MS, NTP_STEADY_INTERVAL_MS, RESYNC_THRESHOLD_MS } from "@hive/protocol";
import { ClockModel, CtxMapper, SLEW_RATE_MS_PER_SEC } from "../clock";

/** Deterministic PRNG (mulberry32) so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimOptions {
  trueOffsetMs: number | ((probeIndex: number) => number);
  pairs: number;
  /** Departure gap inside a pair, ms. */
  gapMs?: number;
  /** Wall-clock spacing between pairs, ms. */
  intervalMs?: number;
  jitterMs?: number;
  spikeProbability?: number;
  spikeMs?: number;
  seed?: number;
  usePairs?: boolean;
}

interface SimStep {
  probeIndex: number;
  verdict: string;
  trueOffsetMs: number;
  /** applied offset error at this point, ms */
  appliedErrorMs: number;
  /** min-RTT estimate error at this point, ms */
  estimateErrorMs: number;
  stepMs: number;
  /** real spacing between this probe's t3 and the previous accepted one — what the slew cap uses */
  dtSec: number;
  spiked: boolean;
  acceptedSoFar: number;
}

/**
 * Drives a ClockModel with synthetic probes. Returns one row per probe so a test can assert on the
 * whole trajectory, not just the final value — a clock that is right at the end and wrong in the
 * middle still made a phone audibly jump.
 */
function simulate(o: SimOptions): { clock: ClockModel; steps: SimStep[] } {
  const rand = rng(o.seed ?? 1);
  const jitter = o.jitterMs ?? 30;
  const spikeP = o.spikeProbability ?? 0.2;
  const spikeMs = o.spikeMs ?? 80;
  const gap = o.gapMs ?? NTP_PROBE_PAIR_GAP_MS;
  const interval = o.intervalMs ?? NTP_STEADY_INTERVAL_MS;
  const clock = new ClockModel({ pairs: o.usePairs ?? true });
  const steps: SimStep[] = [];
  const offsetAt = typeof o.trueOffsetMs === "function" ? o.trueOffsetMs : () => o.trueOffsetMs as number;

  let local = 1_700_000_000_000; // a plausible epoch ms; exercises float precision honestly
  let probeIndex = 0;
  let lastAcceptedT3: number | null = null;

  for (let pair = 0; pair < o.pairs; pair++) {
    // the path state for this pair: one shared base delay each way
    const baseUp = 5 + rand() * jitter * 0.5;
    const baseDown = 5 + rand() * jitter * 0.5;
    const departures = [local, local + gap];
    for (let i = 0; i < 2; i++) {
      const trueOffset = offsetAt(probeIndex);
      const spikeUp = rand() < spikeP / 2 ? spikeMs : 0;
      const spikeDown = rand() < spikeP / 2 ? spikeMs : 0;
      const d1 = baseUp + rand() * 0.6 + spikeUp;
      const d2 = baseDown + rand() * 0.6 + spikeDown;
      const proc = rand() * 0.3;

      const t0 = departures[i]!;
      const t1 = t0 + d1 + trueOffset;
      const t2 = t1 + proc;
      const t3 = t2 - trueOffset + d2;

      const before = clock.offsetMs;
      const acceptedBefore = clock.accepted;
      const verdict = clock.addProbe(t0, t1, t2, t3, pair, i as 0 | 1);
      // The slew cap is proportional to the real gap between accepted probes, which carries the
      // downstream jitter — using the nominal interval here would under-state the cap by ~0.2 ms.
      const dtSec = lastAcceptedT3 === null ? interval / 1000 : (t3 - lastAcceptedT3) / 1000;
      if (clock.accepted > acceptedBefore) lastAcceptedT3 = t3;
      steps.push({
        probeIndex: probeIndex++,
        verdict,
        trueOffsetMs: trueOffset,
        appliedErrorMs: clock.offsetMs == null ? NaN : clock.offsetMs - trueOffset,
        estimateErrorMs: clock.estimateOffsetMs == null ? NaN : clock.estimateOffsetMs - trueOffset,
        stepMs: before == null || clock.offsetMs == null ? 0 : clock.offsetMs - before,
        dtSec,
        spiked: spikeUp > 0 || spikeDown > 0,
        acceptedSoFar: clock.accepted,
      });
    }
    local += interval;
  }
  return { clock, steps };
}

describe("ClockModel", () => {
  test("the NTP math is the documented formula", () => {
    const clock = new ClockModel();
    // true offset +137, d1 = 10, d2 = 14, server processing 1 → offset err = (10-14)/2 = -2, rtt = 24
    const t0 = 1000;
    const t1 = t0 + 10 + 137;
    const t2 = t1 + 1;
    const t3 = t2 - 137 + 14;
    clock.addProbe(t0, t1, t2, t3);
    expect(clock.estimateOffsetMs).toBeCloseTo(137 - 2, 9);
    expect(clock.rttMs).toBeCloseTo(24, 9);
    expect(clock.offsetMs).toBeCloseTo(135, 9); // first estimate adopted directly
  });

  test("+137 ms with ±30 ms jitter and 20 % +80 ms spikes → within 2 ms over 30 probes", () => {
    const { clock, steps } = simulate({ trueOffsetMs: 137, pairs: 15 }); // 15 pairs = 30 probes
    expect(steps).toHaveLength(30);
    expect(clock.offsetMs).not.toBeNull();
    expect(Math.abs(clock.offsetMs! - 137)).toBeLessThan(2);
    expect(Math.abs(clock.estimateOffsetMs! - 137)).toBeLessThan(2);
    expect(clock.rttMs).toBeGreaterThan(0);

    // The *first* estimate is adopted directly and is only as good as one sample: a single probe
    // cannot separate path asymmetry from offset, so it can be several ms out. What fixes it is the
    // window filling up, which is why the 20-pair burst runs over NTP_BURST_WINDOW_MS before anyone
    // presses Play — not the slew, which does not protect the first value.
    const first = steps.find((s) => Number.isFinite(s.appliedErrorMs))!;
    const settled = steps.filter((s) => s.acceptedSoFar >= 6);
    const worstSettled = Math.max(...settled.map((s) => Math.abs(s.appliedErrorMs)));
    expect(worstSettled).toBeLessThan(2);
    console.log(
      `[B2] +137 ms / ±30 ms / 20 % spikes: first estimate err ${first.appliedErrorMs.toFixed(3)} ms, ` +
        `worst once ≥6 samples are in the window ${worstSettled.toFixed(3)} ms, ` +
        `final ${(clock.offsetMs! - 137).toFixed(3)} ms, rtt ${clock.rttMs!.toFixed(2)} ms, ` +
        `accepted ${clock.accepted}, rejected ${clock.rejected}`,
    );
  });

  test("min-RTT selection, not coded pairs, is what removes the spikes (negative result)", () => {
    // Same seed, same probes; the only difference is pair validation. This test exists to record a
    // negative result rather than to claim a win: an +80 ms queueing spike raises that probe's RTT by
    // +80 too, so min-RTT outranks it immediately and the coded pair has nothing left to contribute.
    // Pairs stay on because the protocol already carries the ids and one extra probe per second is
    // cheap insurance against a path where delay is asymmetric *without* costing RTT — but the
    // evidence file should not pretend this simulation demonstrates that.
    const on = simulate({ trueOffsetMs: 137, pairs: 15, usePairs: true });
    const off = simulate({ trueOffsetMs: 137, pairs: 15, usePairs: false });

    expect(on.clock.rejected).toBeGreaterThan(0); // the mechanism did fire on the spiked pairs
    expect(off.clock.rejected).toBe(0);
    expect(off.clock.accepted).toBe(30);

    const worst = (r: typeof on) =>
      Math.max(...r.steps.filter((s) => s.acceptedSoFar >= 6).map((s) => Math.abs(s.appliedErrorMs)));
    expect(worst(on)).toBeLessThan(2);
    expect(worst(off)).toBeLessThan(2); // just as good without pairs, on this traffic model
    console.log(
      `[B2] worst applied error once settled: pairs on ${worst(on).toFixed(3)} ms vs pairs off ` +
        `${worst(off).toFixed(3)} ms — min-RTT is doing the work`,
    );
  });

  test("a pair whose server-side gap disagrees with its departure gap is dropped, both halves", () => {
    const clock = new ClockModel({ pairs: true });
    const send = (t0: number, d1: number, d2: number, id: number, index: 0 | 1) => {
      const t1 = t0 + d1 + 100;
      return clock.addProbe(t0, t1, t1 + 0.1, t1 + 0.1 - 100 + d2, id, index);
    };
    // clean pair: both packets saw the same path → accepted
    expect(send(0, 10, 10, 1, 0)).toBe("buffered");
    expect(send(NTP_PROBE_PAIR_GAP_MS, 10, 10, 1, 1)).toBe("accepted");
    expect(clock.accepted).toBe(2);

    // second member queued by 40 ms on the way up → the server sees a 50 ms gap, not 10 → both dropped
    expect(send(1000, 10, 10, 2, 0)).toBe("buffered");
    expect(send(1000 + NTP_PROBE_PAIR_GAP_MS, 50, 10, 2, 1)).toBe("rejected");
    expect(clock.accepted).toBe(2);
    expect(clock.rejected).toBe(2);
  });

  test("pair rejection relaxes rather than leaving a phone with no clock at all", () => {
    // Every pair is stretched: strict validation would reject all 40 probes forever.
    const clock = new ClockModel({ pairs: true });
    let t = 0;
    for (let pair = 0; pair < 20; pair++) {
      const t1a = t + 10 + 100;
      clock.addProbe(t, t1a, t1a + 0.1, t1a + 0.1 - 100 + 10, pair, 0);
      const t0b = t + NTP_PROBE_PAIR_GAP_MS;
      const t1b = t0b + 60 + 100; // +50 ms of queueing on the second half: never a valid pair
      clock.addProbe(t0b, t1b, t1b + 0.1, t1b + 0.1 - 100 + 10, pair, 1);
      t += 500; // 20 pairs × 500 ms: well past NTP_BURST_WINDOW_MS
    }
    expect(clock.degraded).toBe(true);
    expect(clock.offsetMs).not.toBeNull();
    // it fell back to the better half of a pair, so the estimate is still usable
    expect(Math.abs(clock.offsetMs! - 100)).toBeLessThan(1);
  });

  test("below the resync threshold the applied offset slews and never steps faster than 2 ms/s", () => {
    // The truth moves +6 ms after 20 probes: under RESYNC_THRESHOLD_MS, so it must be slewed in.
    const { clock, steps } = simulate({
      trueOffsetMs: (i) => (i < 20 ? 137 : 143),
      pairs: 60,
      jitterMs: 2,
      spikeProbability: 0,
      seed: 7,
    });
    for (const s of steps) {
      if (Math.abs(s.stepMs) === 0) continue;
      const cap = SLEW_RATE_MS_PER_SEC * s.dtSec;
      // a step is allowed to exceed the cap only when it is the first estimate or a real jump
      if (Math.abs(s.stepMs) > cap + 1e-9) expect(Math.abs(s.stepMs)).toBeGreaterThan(RESYNC_THRESHOLD_MS);
    }
    const slewSteps = steps.filter((s) => s.stepMs !== 0 && Math.abs(s.stepMs) <= RESYNC_THRESHOLD_MS);
    expect(slewSteps.length).toBeGreaterThan(3);
    for (const s of slewSteps) expect(Math.abs(s.stepMs)).toBeLessThanOrEqual(SLEW_RATE_MS_PER_SEC * s.dtSec + 1e-9);
    // and it did converge on the new truth
    expect(Math.abs(clock.offsetMs! - 143)).toBeLessThan(2);
    const largest = Math.max(...slewSteps.map((s) => Math.abs(s.stepMs)));
    console.log(
      `[B2] slew: ${slewSteps.length} corrections to absorb a +6 ms change, largest ${largest.toFixed(3)} ms ` +
        `at ~1 Hz (cap ${SLEW_RATE_MS_PER_SEC} ms/s)`,
    );
  });

  test("an error above the resync threshold is applied at once", () => {
    const { clock, steps } = simulate({
      trueOffsetMs: (i) => (i < 10 ? 137 : 237), // a route change: +100 ms
      pairs: 20,
      jitterMs: 2,
      spikeProbability: 0,
      seed: 3,
    });
    const jump = steps.find((s) => Math.abs(s.stepMs) > RESYNC_THRESHOLD_MS);
    expect(jump).toBeDefined();
    expect(Math.abs(clock.offsetMs! - 237)).toBeLessThan(2);
    // the whole 100 ms went in one correction, not fifty seconds of slewing
    expect(Math.abs(jump!.stepMs)).toBeGreaterThan(90);
  });

  test("the burst schedule the engine uses converges inside its window", () => {
    // NTP_BURST_COUNT pairs at NTP_BURST_WINDOW_MS / NTP_BURST_COUNT spacing, as the client sends them.
    const { clock } = simulate({ trueOffsetMs: 137, pairs: NTP_BURST_COUNT, intervalMs: 200, seed: 11 });
    expect(Math.abs(clock.offsetMs! - 137)).toBeLessThan(2);
    expect(clock.accepted).toBeGreaterThan(10);
  });

  test("serverNow and localTimeFor are inverses", () => {
    const clock = new ClockModel();
    clock.addProbe(1000, 1000 + 10 + 137, 1000 + 10 + 137, 1010 + 137 - 137 + 10);
    const s = clock.serverNow(5000);
    expect(clock.localTimeFor(s)).toBeCloseTo(5000, 9);
  });
});

describe("CtxMapper", () => {
  test("maps a server time to a ctx time through one relation", () => {
    const clock = new ClockModel();
    // offset exactly +137: d1 = d2 = 10, no processing time
    clock.addProbe(1_700_000_000_000, 1_700_000_000_147, 1_700_000_000_147, 1_700_000_000_020);
    expect(clock.offsetMs).toBeCloseTo(137, 6);

    const mapper = new CtxMapper(clock);
    const local = 1_700_000_000_000;
    mapper.addSample(local, 12.0); // ctx.currentTime = 12 s when local = that epoch ms
    // server time 1s later than (local + offset) must be ctx 13.0
    expect(mapper.ctxTimeFor(clock.serverNow(local) + 1000)).toBeCloseTo(13.0, 6);
  });

  test("the median ignores quantisation outliers a mean would smear in", () => {
    const clock = new ClockModel();
    clock.addProbe(0, 0, 0, 0); // offset 0
    const mapper = new CtxMapper(clock);
    const local = 1_700_000_000_000;
    for (let i = 0; i < 9; i++) mapper.addSample(local + i * 1000, 10 + i); // a clean 1:1 series
    mapper.addSample(local + 9000, 19 + 0.5); // one throttled-tab outlier: ctx ran 500 ms late
    const clean = 10 - local / 1000;
    expect(mapper.localToCtxSec!).toBeCloseTo(clean, 6);
    expect(mapper.sampleCount).toBe(10);
  });

  test("the one-tick form agrees with the sampled form when the sample is fresh", () => {
    const clock = new ClockModel();
    clock.addProbe(1_700_000_000_000, 1_700_000_000_137, 1_700_000_000_137, 1_700_000_000_000);
    const mapper = new CtxMapper(clock);
    const local = 1_700_000_000_000;
    const ctxNow = 42.125;
    mapper.addSample(local, ctxNow);
    const target = clock.serverNow(local) + 450; // schedule 450 ms out
    expect(mapper.ctxTimeForNow(target, ctxNow, local)).toBeCloseTo(mapper.ctxTimeFor(target), 6);
    expect(mapper.ctxTimeForNow(target, ctxNow, local)).toBeCloseTo(ctxNow + 0.45, 6);
  });
});

/*
 * Sample age. min-RTT selection has no notion of it, and that is a bug rather than a simplification: an
 * offset goes stale on its own, because the local clock drifts against the server. A phone whose tab was
 * suspended, or that lost the socket for a few minutes, comes back with a window full of samples whose
 * offsets are wrong by (gap × drift) — and if one of them has a lucky low RTT it wins the selection and
 * pins the phone tens of ms out of sync while reporting a 2 ms RTT and a healthy syncErrMs. Confidently
 * wrong, like every other bug in this engine's list.
 */
describe("the min-RTT window drops samples by age as well as by count", () => {
  const L = 1_700_000_000_000;
  /** A probe with a known true offset and a symmetric one-way delay, so rtt = 2·owd exactly. */
  const probe = (m: ClockModel, at: number, offset: number, owdMs: number) =>
    m.addProbe(at, at + offset + owdMs, at + offset + owdMs, at + 2 * owdMs);

  test("a lucky low-RTT sample from before a long gap no longer pins the clock", () => {
    const m = new ClockModel();
    for (let i = 0; i < 29; i++) probe(m, L + i * 1000, 0, 12);
    probe(m, L + 29_000, 0, 1); // the lucky one: rtt 2 ms, and its offset is the truth *at that time*
    expect(m.estimateOffsetMs).toBeCloseTo(0, 6);
    expect(m.rttMs).toBeCloseTo(2, 6);

    // ten minutes suspended; the local clock has drifted so the true offset is now +30 ms
    const after = L + 29_000 + 600_000;
    for (let i = 0; i < 5; i++) probe(m, after + i * 1000, 30, 12);

    expect(m.estimateOffsetMs).toBeCloseTo(30, 6); // follows the fresh truth, not the lucky stale sample
    expect(m.rttMs).toBeCloseTo(24, 6); // and reports the RTT it can actually see now
  });

  test("steady 1 Hz probing is unaffected: nothing inside the window is ever pruned", () => {
    const m = new ClockModel();
    for (let i = 0; i < 40; i++) probe(m, L + i * 1000, 0, i === 20 ? 3 : 14);
    // the low-RTT sample at t=20 s is 19 s old at the end — inside NTP_SAMPLE_MAX_AGE_MS, so it still wins
    expect(m.rttMs).toBeCloseTo(6, 6);
    expect(m.estimateOffsetMs).toBeCloseTo(0, 6);
  });

  test("a phone that comes back after an hour is never left with no clock at all", () => {
    const m = new ClockModel();
    probe(m, L, 0, 12);
    const muchLater = L + 3_600_000;
    // the only sample in the window is older than the age bound; the newest must be kept regardless
    probe(m, muchLater, 40, 12);
    expect(m.estimateOffsetMs).toBeCloseTo(40, 6);
    expect(m.rttMs).toBeCloseTo(24, 6);
    expect(m.serverNow(muchLater)).toBeGreaterThan(muchLater); // it has a usable clock
  });
});
