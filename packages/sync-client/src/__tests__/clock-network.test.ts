/**
 * ENGINE-SYNC-05 · the clock model on realistic networks, with the error measured rather than inferred.
 *
 * `net-sim.ts` drives the real `ClockModel` with the engine's own probe schedule over a simulated link,
 * against a true offset the test controls. Each scenario runs over many seeds; the thresholds below are
 * the measured results with headroom, and the measured numbers (30 seeds) are quoted beside them so a
 * regression reads as a number, not as "it got worse".
 *
 * What the simulation established, and what changed because of it:
 *  - a clock **step** (the phone slept and `performance.now()` stood still; NTP stepped the server) was
 *    followed for 10 s on average and up to 19 s on good Wi-Fi — the low-RTT samples from before the step
 *    kept winning min-RTT selection until 30 newer ones displaced them. Now: the first sample after it.
 *  - on a jittery cellular link nine coded pairs in ten fail the 2 ms test, and all of them were thrown
 *    away, including the low-RTT halves min-RTT selection exists to find. Mean error 5.4 → 2.4 ms.
 *  - a path with different delay in each direction biases the clock by half the difference, and nothing
 *    measured over that path can see it. That is pinned here as a known limit, not fixed.
 */
import { describe, expect, test } from "bun:test";
import { NTP_BURST_WINDOW_MS, NTP_SAMPLE_MAX_AGE_MS, RESYNC_THRESHOLD_MS } from "@hive/protocol";
import {
  ClockModel, CONSISTENCY_SLACK_MS, createEngineClock, FLOOR_FIRST_MIN_PROBES, FLOOR_HOLD_MS, SLEW_RATE_MS_PER_SEC,
} from "../clock";
import { asymmetricLink, burstyLink, iidLink, simulateClock, wanderingLink, type ClockSimOptions } from "./net-sim";
import { rng } from "./sim";

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Summary {
  meanAbs: number;
  worstP95: number;
  worstMax: number;
  meanSteps: number;
  worstFirstClockMs: number;
  meanSettleMs: number;
  worstSettleMs: number;
}

/** Runs one scenario across every seed and reduces it to the numbers the assertions use. */
function run(
  make: (rand: () => number) => ClockSimOptions,
  steadyFromMs: number,
  settle?: { afterMs: number; underMs: number },
): Summary {
  const rows = SEEDS.map((seed) => {
    const r = simulateClock(make(rng(seed)));
    const s = r.stats(steadyFromMs);
    const settledAt = settle ? r.settledAt(settle.afterMs, settle.underMs) : null;
    return {
      mean: s.meanAbs,
      p95: s.p95,
      max: s.max,
      steps: r.steps,
      first: r.firstClockAtMs ?? Infinity,
      settle: settle ? (settledAt ?? Infinity) - settle.afterMs : 0,
    };
  });
  return {
    meanAbs: avg(rows.map((r) => r.mean)),
    worstP95: Math.max(...rows.map((r) => r.p95)),
    worstMax: Math.max(...rows.map((r) => r.max)),
    meanSteps: avg(rows.map((r) => r.steps)),
    worstFirstClockMs: Math.max(...rows.map((r) => r.first)),
    meanSettleMs: avg(rows.map((r) => r.settle)),
    worstSettleMs: Math.max(...rows.map((r) => r.settle)),
  };
}

const FIVE_MIN = 300_000;
const steady = (link: (rand: () => number) => ClockSimOptions["link"], durationMs = FIVE_MIN) =>
  run((rand) => ({ durationMs, link: link(rand), trueOffset: () => 1234.5 }), 10_000);

describe("ENGINE-SYNC-05 · steady-state accuracy by link", () => {
  test("home Wi-Fi (3 ± 2 ms each way): sub-millisecond, never a step", () => {
    const s = steady((r) => iidLink(r, 3, 2)); // measured: mean 0.20, worst p95 0.7, worst max 1.0, first clock ≤ 218 ms
    expect(s.meanAbs).toBeLessThan(0.5);
    expect(s.worstP95).toBeLessThan(1.5);
    expect(s.worstMax).toBeLessThan(2.5);
    expect(s.meanSteps).toBe(0);
    expect(s.worstFirstClockMs).toBeLessThan(1000);
  });

  test("crowded Wi-Fi (8 ± 6 ms): still inside the 2–5 ms clock budget", () => {
    const s = steady((r) => iidLink(r, 8, 6)); // measured: mean 0.59, worst p95 2.6, worst max 5.1
    expect(s.meanAbs).toBeLessThan(1.2);
    expect(s.worstP95).toBeLessThan(4);
    expect(s.meanSteps).toBe(0);
  });

  test("4G-like, 80 ± 40 ms round trip, independent jitter: a few ms, not the 5–8 it was", () => {
    const s = steady((r) => iidLink(r, 40, 20)); // measured: mean 2.35 (was 5.44), worst p95 11.8 (was 14.4)
    expect(s.meanAbs).toBeLessThan(3.5);
    expect(s.worstP95).toBeLessThan(14);
    expect(s.worstMax).toBeLessThan(25);
    // the clock comes up inside the burst window plus one probe, even when no pair passes
    expect(s.worstFirstClockMs).toBeLessThan(NTP_BURST_WINDOW_MS + 1500);
  });

  test("4G-like with a wandering queue (correlated jitter): pairs pass, min-RTT does the work", () => {
    const s = steady((r) => wanderingLink(r, 40, 20, 4)); // measured: mean 2.77, worst p95 9.6
    expect(s.meanAbs).toBeLessThan(4);
    expect(s.worstP95).toBeLessThan(13);
  });

  test("jitter bursts (2 s of +200 ms every 20 s, both ways or uplink only) do not reach the clock", () => {
    for (const where of ["both", "up"] as const) {
      const s = steady((r) => burstyLink(r, iidLink(r, 4, 2), 20_000, 2000, 200, where)); // measured: mean 0.2, worst max 1.2
      expect(s.meanAbs).toBeLessThan(0.6);
      expect(s.worstMax).toBeLessThan(3);
      expect(s.meanSteps).toBe(0);
    }
  });

  test("a 50 ppm local crystal over ten minutes is tracked on Wi-Fi without a single step", () => {
    const s = run((r) => ({ durationMs: 600_000, link: iidLink(r, 3, 2), trueOffset: (t) => 1000 + t * 50e-6 }), 10_000);
    expect(s.meanAbs).toBeLessThan(1); // measured 0.52
    expect(s.worstMax).toBeLessThan(4); // measured 2.2
    expect(s.meanSteps).toBe(0);
  });

  test("KNOWN LIMIT: a path that is slower one way biases the clock by half the difference", () => {
    // up 60 ms, down 20 ms → every sample reads (60 − 20)/2 = 20 ms wrong, with a perfectly ordinary RTT.
    // No round-trip measurement can see this; the acoustic tuning moment is what removes it per phone.
    const s = steady((r) => asymmetricLink(r, 60, 20, 5));
    expect(s.meanAbs).toBeGreaterThan(18);
    expect(s.meanAbs).toBeLessThan(22);
  });
});

describe("ENGINE-SYNC-05 · a step in the offset is followed at once", () => {
  const stepAt = 60_000;
  const stepped = (sizeMs: number, link: (rand: () => number) => ClockSimOptions["link"], underMs = 5) =>
    run(
      (rand) => ({ durationMs: 180_000, link: link(rand), trueOffset: (t) => (t < stepAt ? 0 : sizeMs) }),
      90_000,
      { afterMs: stepAt, underMs },
    );

  test("Wi-Fi: +500 ms (the phone slept and performance.now() stood still) settles on the next probe", () => {
    const s = stepped(500, (r) => iidLink(r, 3, 2)); // measured: 16 ms average, 19 ms worst (was 10.3 s / 19.0 s)
    expect(s.worstSettleMs).toBeLessThan(1500);
    expect(s.meanSteps).toBe(1); // one correction, not a staircase
    expect(s.meanAbs).toBeLessThan(0.5); // and the steady state afterwards is as good as before
  });

  test("Wi-Fi: −30 ms (an NTP step on the server) likewise", () => {
    const s = stepped(-30, (r) => iidLink(r, 3, 2));
    expect(s.worstSettleMs).toBeLessThan(1500);
    expect(s.meanSteps).toBe(1);
  });

  test("4G: +500 ms is caught by a failed pair acting as a witness, not after the window has turned over", () => {
    const s = stepped(500, (r) => iidLink(r, 40, 20), 15); // measured: 0.36 s average, 6.1 s worst (was 20 s / 50 s)
    expect(s.meanSettleMs).toBeLessThan(2000);
    expect(s.worstSettleMs).toBeLessThan(12_000);
  });

  test("a step smaller than the measurement noise is slewed, never stepped", () => {
    const s = stepped(8, (r) => iidLink(r, 3, 2), 2); // 8 ms < RESYNC_THRESHOLD_MS: absorbed at ≤ 2 ms/s
    expect(s.meanSteps).toBe(0);
    expect(s.worstSettleMs).toBeLessThan(30_000);
  });

  test("a reconnect onto a moved clock (server restart) is right within the burst", () => {
    const s = run(
      (rand) => ({
        durationMs: 180_000,
        link: iidLink(rand, 5, 3),
        trueOffset: (t) => (t < 58_000 ? 0 : 200),
        gaps: [[57_000, 60_000]],
        reconnectsAt: [60_000],
      }),
      90_000,
      { afterMs: 60_000, underMs: 5 },
    ); // measured: 20 ms average, 23 ms worst (was 2.2 s / 4.0 s)
    expect(s.worstSettleMs).toBeLessThan(1500);
  });

  test("a 90 s gap in probing (frozen tab) during which the offset moved 40 ms", () => {
    const s = run(
      (rand) => ({
        durationMs: 240_000,
        link: iidLink(rand, 3, 2),
        trueOffset: (t) => (t < 100_000 ? 0 : 40),
        gaps: [[60_000, 150_000]],
      }),
      160_000,
      { afterMs: 150_000, underMs: 5 },
    );
    expect(s.worstSettleMs).toBeLessThan(3000);
  });
});

describe("ENGINE-SYNC-05 · the consistency test itself", () => {
  const at = 1_700_000_000_000;
  /** One unpaired probe with the given true offset and one-way delays. */
  const probe = (c: ClockModel, t: number, offset: number, up: number, down: number): void => {
    c.addProbe(at + t, at + t + up + offset, at + t + up + offset, at + t + up + down);
  };

  test("an excellent old sample cannot outvote a newer one it contradicts", () => {
    const c = new ClockModel();
    for (let i = 0; i < 20; i++) probe(c, i * 1000, 0, 1, 1); // rtt 2 ms: unbeatable on RTT
    expect(c.offsetMs).toBeCloseTo(0, 6);
    probe(c, 20_000, 400, 6, 6); // rtt 12 ms, and 400 ms away: both cannot be true
    expect(c.estimateOffsetMs).toBeCloseTo(400, 6);
    expect(c.offsetMs).toBeCloseTo(400, 6);
    expect(c.stepsDetected).toBe(1);
  });

  test("samples that merely disagree inside their own uncertainty are all kept", () => {
    const c = new ClockModel();
    probe(c, 0, 0, 2, 2); // true offset 0, read exactly
    probe(c, 1000, 0, 30, 2); // reads +14 ms, but its rtt of 32 ms allows for that
    probe(c, 2000, 0, 2, 40); // reads −19 ms, rtt 42 ms
    expect(c.stepsDetected).toBe(0);
    expect(c.estimateOffsetMs).toBeCloseTo(0, 6); // min-RTT still picks the honest one
  });

  test("ordinary crystal drift across the window is not mistaken for a step", () => {
    const c = new ClockModel();
    // 100 ppm for 30 s is 3 ms; with 1 ms round trips the intervals are 1 ms wide and would not overlap
    // without the slack.
    for (let i = 0; i <= 30; i++) probe(c, i * 1000, i * 1000 * 100e-6, 0.5, 0.5);
    expect(3).toBeLessThan(CONSISTENCY_SLACK_MS);
    expect(c.stepsDetected).toBe(0);
  });
});

describe("ENGINE-SYNC-22 · the floor estimator's own rules", () => {
  const at = 1_700_000_000_000;
  /** One probe at local time `t` with the given true offset and one-way delays. */
  const probe = (c: ClockModel, t: number, offset: number, up: number, down: number) =>
    c.addProbe(at + t, at + t + up + offset, at + t + up + offset, at + t + up + down);

  test("first estimate: a probe that bounds the error is adopted at once; a slow one waits for ten", () => {
    const quick = createEngineClock();
    expect(probe(quick, 0, 100, 12, 12)).toBe("accepted"); // rtt 24 ms: error ≤ 12 ms whatever happened
    expect(quick.offsetMs).toBeCloseTo(100, 6);
    expect(quick.degraded).toBe(false);

    const slow = createEngineClock();
    for (let i = 0; i < FLOOR_FIRST_MIN_PROBES - 1; i++) {
      expect(probe(slow, i * 100, 100, 150 + i, 20)).toBe("buffered"); // rtt ≥ 170 ms: could be 85 ms wrong
      expect(slow.offsetMs).toBeNull();
    }
    expect(probe(slow, 1000, 100, 40, 38)).toBe("accepted"); // the tenth: best of what there is
    expect(slow.offsetMs).toBeCloseTo(101, 6); // (40 − 38) / 2 of asymmetry, from the rtt-78 sample
    expect(slow.degraded).toBe(true); // …and /diag can say the bound was not met
    probe(slow, 1100, 100, 10, 10);
    expect(slow.degraded).toBe(false); // until a sample that does meet it arrives
  });

  test("a phone whose every probe is slow still gets a clock when the burst window ends", () => {
    const c = createEngineClock();
    probe(c, 0, 50, 300, 300);
    expect(c.offsetMs).toBeNull();
    probe(c, NTP_BURST_WINDOW_MS + 100, 50, 300, 300);
    expect(c.offsetMs).toBeCloseTo(50, 6);
  });

  test("hold-over: one-way congestion is not followed, and the hold ends when the floor comes back", () => {
    const c = createEngineClock();
    for (let i = 0; i < 40; i++) probe(c, i * 500, 0, 4, 4);
    expect(c.offsetMs).toBeCloseTo(0, 3);
    expect(c.floorRttMs).toBeCloseTo(8, 6);
    // a big upload on the same Wi-Fi: 60 ms of extra uplink delay, for 40 s
    for (let i = 0; i < 80; i++) probe(c, 20_000 + i * 500, 0, 64, 4);
    expect(c.holding).toBe(true);
    expect(Math.abs(c.offsetMs!)).toBeLessThan(0.01); // every one of those samples read +30 ms
    for (let i = 0; i < 4; i++) probe(c, 60_000 + i * 500, 0, 4, 4);
    expect(c.holding).toBe(false);
    expect(Math.abs(c.offsetMs!)).toBeLessThan(0.01);
  });

  test("hold-over ends by itself: after FLOOR_HOLD_MS the longer path is the new floor", () => {
    const c = createEngineClock();
    for (let i = 0; i < 20; i++) probe(c, i * 500, 0, 10, 10);
    // the path gets 90 ms longer, symmetrically, for good (a hotspot hand-over)
    // For the first 30 s the old samples are still in the window and still the best there is (nothing
    // about the clock changed); the hold-over proper starts when the last of them has aged out.
    let t = 10_000;
    const floorGoneAt = 9500 + NTP_SAMPLE_MAX_AGE_MS;
    for (; t < floorGoneAt + FLOOR_HOLD_MS - 1000; t += 500) probe(c, t, 0, 55, 55);
    expect(c.holding).toBe(true);
    expect(c.floorRttMs).toBeCloseTo(20, 6);
    for (; t < floorGoneAt + FLOOR_HOLD_MS + 2000; t += 500) probe(c, t, 0, 55, 55);
    expect(c.holding).toBe(false);
    expect(c.floorRttMs).toBeCloseTo(110, 6);
    expect(Math.abs(c.offsetMs!)).toBeLessThan(0.01);
  });

  test("a real step overrides the hold-over at once", () => {
    const c = createEngineClock();
    for (let i = 0; i < 20; i++) probe(c, i * 500, 0, 4, 4);
    for (let i = 0; i < 70; i++) probe(c, 10_000 + i * 500, 0, 64, 4); // 35 s of congestion: holding
    expect(c.holding).toBe(true);
    probe(c, 45_000, 400, 64, 4); // still congested, and the clock is now 400 ms away: both cannot be true
    expect(c.stepsDetected).toBe(1);
    expect(c.offsetMs!).toBeGreaterThan(400 - 1);
    expect(c.offsetMs!).toBeLessThan(400 + 34 + 1); // within that sample's own bound (rtt 68)
  });

  test("an old sample loses to a newer one of nearly the same quality (age is part of the bound)", () => {
    const c = createEngineClock();
    probe(c, 0, 0, 5, 5); // rtt 10, read exactly
    probe(c, 25_000, 2, 5.5, 5.5); // rtt 11, 25 s later — the crystal has moved 2 ms meanwhile
    // 10/2 + 50 ppm × 25 s = 6.25 ms against 11/2 = 5.5 ms: the fresh one wins
    expect(c.estimateOffsetMs).toBeCloseTo(2, 6);
  });

  test("the window is bounded by age and by count", () => {
    const c = createEngineClock();
    for (let i = 0; i < 5000; i++) probe(c, i * 10, 0, 3 + (i % 5), 3);
    expect(c.accepted).toBe(5000);
    expect(Math.abs(c.offsetMs!)).toBeLessThan(2.5);
    // nothing to read the window size from outside; what matters is that 50 s of 100 Hz probing costs
    // the same per probe at the end as at the start
    const t0 = performance.now();
    for (let i = 5000; i < 10_000; i++) probe(c, i * 10, 0, 3 + (i % 5), 3);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("ENGINE-SYNC-05 · the slew limiter cannot overshoot, oscillate or run away", () => {
  test("after every probe the applied offset is between where it was and the estimate, and moves no faster than allowed", () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const c = new ClockModel();
      const at = 1_700_000_000_000;
      let t = 0;
      let trueOffset = 50;
      let previous: number | null = null;
      let previousT = 0;
      for (let i = 0; i < 3000; i++) {
        // mostly ≤ 2 s apart, sometimes a long silence; replies arrive in order, as on one socket
        t = Math.max(previousT + 1, t + 5 + rand() * (rand() < 0.02 ? 60_000 : 2000));
        if (rand() < 0.01) trueOffset += (rand() * 2 - 1) * 300; // an occasional step
        trueOffset += (rand() * 2 - 1) * 0.5; // wander
        const up = rand() * (rand() < 0.1 ? 200 : 20);
        const down = rand() * (rand() < 0.1 ? 200 : 20);
        c.addProbe(at + t, at + t + up + trueOffset, at + t + up + trueOffset, at + t + up + down);
        const now = c.offsetMs!;
        const est = c.estimateOffsetMs!;
        expect(Number.isFinite(now)).toBe(true);
        if (previous !== null) {
          const lo = Math.min(previous, est) - 1e-6;
          const hi = Math.max(previous, est) + 1e-6;
          // never past the estimate, never away from it
          expect(now).toBeGreaterThanOrEqual(lo);
          expect(now).toBeLessThanOrEqual(hi);
          const moved = Math.abs(now - previous);
          const dtSec = (t + up + down - previousT) / 1000;
          const wasStep = Math.abs(est - previous) > RESYNC_THRESHOLD_MS;
          // a slew is rate-limited; only an error past the resync threshold may be taken at once
          // (1e-3: epoch-millisecond floats resolve to ~2e-4 ms)
          if (!wasStep) expect(moved).toBeLessThanOrEqual(SLEW_RATE_MS_PER_SEC * dtSec + 1e-3);
          else expect(now).toBeCloseTo(est, 3);
        }
        previous = now;
        previousT = t + up + down;
      }
    }
  });
});
