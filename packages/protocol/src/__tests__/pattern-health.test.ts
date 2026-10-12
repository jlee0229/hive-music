import { describe, expect, test } from "bun:test";
import { computeSyncErrMs, healthLevel } from "../health";
import { evaluatePattern } from "../pattern";

describe("evaluatePattern", () => {
  test("wave is a raised cosine in [0,1] that peaks half a period after the phase", () => {
    const p = { kind: "wave" as const, periodMs: 2000, phaseMs: 500 };
    expect(evaluatePattern(p, 500)).toBeCloseTo(0, 6);
    expect(evaluatePattern(p, 1500)).toBeCloseTo(1, 6);
    for (let t = -5000; t < 5000; t += 37) {
      const v = evaluatePattern(p, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  test("strobe is on for duty·period with ramps, off otherwise", () => {
    const p = { kind: "strobe" as const, periodMs: 1000, phaseMs: 0, duty: 0.5, rampMs: 10 };
    expect(evaluatePattern(p, 250)).toBe(1);
    expect(evaluatePattern(p, 750)).toBe(0);
    // Deliberately changed (PROTO-09): this asserted 0.5 at t = 5, i.e. a ramp lying inside the window
    // (0 → 1 over [0, 10]). The ramp is now centred on the edge (0 → 1 over [−5, +5]) so that two
    // back-to-back gates cross-fade instead of both being silent at the switch.
    expect(evaluatePattern(p, 0)).toBeCloseTo(0.5, 9);
    expect(evaluatePattern(p, 5)).toBe(1);
    expect(evaluatePattern(p, -5)).toBe(0);
    expect(evaluatePattern(p, 500)).toBeCloseTo(0.5, 9); // the closing edge, centred the same way
    expect(evaluatePattern(p, 1250)).toBe(1); // periodic
    expect(evaluatePattern(p, -250)).toBe(0); // negative time wraps
  });

  test("PROTO-09 · back-to-back strobe gates sum to exactly 1 through the handoff", () => {
    for (const [period, groups] of [[1000, 2], [937.5, 2], [2000, 4], [157.89473684210526, 2], [13714.285714285714, 8], [100, 2]] as const) {
      const slot = period / groups;
      const gates = Array.from({ length: groups }, (_, g) => ({ kind: "strobe" as const, periodMs: period, phaseMs: 250.3 + g * slot, duty: 1 / groups, rampMs: 10 }));
      let min = Infinity;
      let max = -Infinity;
      for (let t = -period; t < 3 * period; t += Math.min(0.25, slot / 400)) {
        const sum = gates.reduce((acc, g) => acc + evaluatePattern(g, t), 0);
        min = Math.min(min, sum);
        max = Math.max(max, sum);
      }
      // was min 0: both gates silent at every switch
      expect(min, `period ${period} × ${groups}`).toBeGreaterThan(1 - 1e-9);
      expect(max, `period ${period} × ${groups}`).toBeLessThan(1 + 1e-9);
    }
  });

  test("PROTO-09 · the on-time is exactly duty·period, whatever the ramp", () => {
    for (const [duty, rampMs] of [[0.5, 10], [0.25, 10], [0.05, 10], [0.9, 40], [0.5, 0]] as const) {
      const p = { kind: "strobe" as const, periodMs: 400, phaseMs: 33, duty, rampMs };
      let area = 0;
      const dt = 0.01;
      for (let t = 0; t < 400; t += dt) area += evaluatePattern(p, t) * dt;
      expect(area / 400).toBeCloseTo(duty, 3);
    }
  });

  test("PROTO-09 · edge cases: duty 1 and 0, zero ramp, before the start, garbage in", () => {
    const base = { kind: "strobe" as const, periodMs: 500, phaseMs: 100, rampMs: 10 };
    for (let t = -2000; t < 2000; t += 3.7) {
      expect(evaluatePattern({ ...base, duty: 1 }, t)).toBe(1); // was a 20 ms dip to 0 once per period
      expect(evaluatePattern({ ...base, duty: 0 }, t)).toBe(0);
      const v = evaluatePattern({ ...base, duty: 0.5 }, t);
      expect(v >= 0 && v <= 1).toBe(true);
      const hard = evaluatePattern({ ...base, duty: 0.5, rampMs: 0 }, t);
      expect(hard === 0 || hard === 1).toBe(true);
    }
    // before the start (negative track time) is the same gate extended backwards: no jump at t = 0
    const p = { ...base, duty: 0.5 };
    for (let t = -1000; t < 0; t += 7.3) expect(evaluatePattern(p, t)).toBeCloseTo(evaluatePattern(p, t + 3 * 500), 9);
    expect(Math.abs(evaluatePattern(p, -1e-6) - evaluatePattern(p, 1e-6))).toBeLessThan(1e-3);
    // garbage must come out audible and finite, never NaN (setValueCurveAtTime throws on NaN)
    for (const t of [NaN, Infinity, -Infinity]) {
      expect(evaluatePattern(p, t)).toBe(1);
      expect(evaluatePattern({ kind: "wave", periodMs: 2000, phaseMs: 0 }, t)).toBe(1);
    }
    expect(evaluatePattern({ ...p, periodMs: Infinity }, 5)).toBe(1);
    expect(evaluatePattern({ ...p, phaseMs: NaN }, 5)).toBe(1);
    // a ramp longer than the window or the gap is cut down to fit, and stays in [0, 1]
    for (let t = 0; t < 500; t += 1.3) {
      const v = evaluatePattern({ ...base, duty: 0.02, rampMs: 400 }, t);
      expect(v >= 0 && v <= 1).toBe(true);
    }
  });
  test("no pattern → always on", () => {
    expect(evaluatePattern(null, 123)).toBe(1);
  });
});

describe("healthLevel", () => {
  const h = (syncErrMs: number | null, ago = 0) => ({ rttMs: 20, syncErrMs, outputLatencyMs: null, audioState: "ready" as const, lastSeenServerTime: 10_000 - ago });
  test("thresholds 5 / 20 ms, stale after 5 s, unknown without data", () => {
    expect(healthLevel(h(3), 10_000)).toBe("good");
    expect(healthLevel(h(5), 10_000)).toBe("good");
    expect(healthLevel(h(12), 10_000)).toBe("warn");
    expect(healthLevel(h(20), 10_000)).toBe("warn");
    expect(healthLevel(h(21), 10_000)).toBe("bad");
    expect(healthLevel(h(3, 6000), 10_000)).toBe("bad");
    expect(healthLevel(h(null), 10_000)).toBe("unknown");
    expect(healthLevel(null, 10_000)).toBe("unknown");
  });
  test("syncErr = rtt/2 + |correction|", () => {
    expect(computeSyncErrMs(20, -3)).toBe(13);
    // the two-argument call is unchanged: the third parameter defaults to 0
    expect(computeSyncErrMs(20, -3, 0)).toBe(13);
  });

  test("syncErr takes the max of the last correction and the live playhead error, never the sum", () => {
    /*
     * The live term exists because B9e's rate slewing removed the only signal the two-term version had: a
     * phone whose trim is saturated sits at real error with `lastCorrectionMs` still 0, and would report
     * itself green until the moment it crossfades.
     */
    expect(computeSyncErrMs(20, 0, 9)).toBe(19); // drifting, never corrected: the live term speaks
    expect(computeSyncErrMs(20, 9, 0)).toBe(19); // just corrected: the history term still speaks
    expect(computeSyncErrMs(20, 9, 9)).toBe(19); // both: 19, NOT 28 — same quantity, not two errors
    expect(computeSyncErrMs(20, -9, 4)).toBe(19); // sign-insensitive, and the larger one wins
    expect(computeSyncErrMs(20, 4, -9)).toBe(19);

    // and it crosses the health bands where it should: 0.4 ms of slewing residual is invisible…
    const h = (syncErrMs: number) => ({ rttMs: 20, syncErrMs, outputLatencyMs: null, audioState: "ready" as const, lastSeenServerTime: 9000 });
    expect(healthLevel(h(computeSyncErrMs(6, 0, 0.4)), 10_000)).toBe("good"); // 3.4 ms
    // …while a saturated trim at 9 ms of drift is not
    expect(healthLevel(h(computeSyncErrMs(6, 0, 9)), 10_000)).toBe("warn"); // 12 ms
  });
});
