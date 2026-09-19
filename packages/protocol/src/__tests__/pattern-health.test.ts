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
    expect(evaluatePattern(p, 5)).toBeCloseTo(0.5, 6);
    expect(evaluatePattern(p, 1250)).toBe(1); // periodic
    expect(evaluatePattern(p, -250)).toBe(0); // negative time wraps
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
  });
});
