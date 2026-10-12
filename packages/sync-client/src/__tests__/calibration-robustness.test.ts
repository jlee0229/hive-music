/**
 * Audit regressions for the matched filter (ENGINE-DSP-40…): synthetic recordings with a known answer,
 * degraded the way a real capture is. The server *accumulates* every residual it accepts, so each case
 * states which of the two failures it is guarding — a miss (a good click rejected) or a false accept
 * (a confident residual that is wrong).
 */
import { describe, expect, test } from "bun:test";
import { CALIBRATION_CLICK_INTERVAL_MS, DEFAULT_CLICK_SPEC } from "@hive/protocol";
import { renderClick } from "../calibration/click";
import { analyzeClicks, DEFAULT_MIN_CONFIDENCE } from "../calibration/xcorr";

const RATE = 48000;
const PER_MS = RATE / 1000;
const INTERVAL = CALIBRATION_CLICK_INTERVAL_MS;
const template = renderClick(DEFAULT_CLICK_SPEC, RATE);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Low-passed noise at roughly `rmsLevel`: a quiet room. */
function room(lengthMs: number, rmsLevel: number, seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(Math.round(lengthMs * PER_MS));
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    last = 0.96 * last + 0.04 * (rand() * 2 - 1);
    out[i] = last * rmsLevel * 12;
  }
  return out;
}

function addClick(recording: Float32Array, atMs: number, gain: number): void {
  const start = Math.round(atMs * PER_MS);
  for (let i = 0; i < template.length; i++) {
    const at = start + i;
    if (at >= 0 && at < recording.length) recording[at]! += template[i]! * gain;
  }
}

const analyze = (recording: Float32Array, expectedMs: number[]) =>
  analyzeClicks({ recording, sampleRate: RATE, template, expectedMs });

describe("ENGINE-DSP-40: one bad sample must not blind the rest of the recording", () => {
  // Three phones, all exactly on time, 20 ms of reference latency.
  const expected = [200, 200 + INTERVAL, 200 + 2 * INTERVAL];
  const clean = () => {
    const rec = room(3 * INTERVAL + 400, 0.005, 7);
    for (const e of expected) addClick(rec, e + 20, 0.5);
    return rec;
  };

  for (const [name, bad] of [["NaN", NaN], ["+Infinity", Infinity], ["-Infinity", -Infinity]] as const) {
    test(`${name} at 2 ms, before every click: all three clicks are still measured`, () => {
      const rec = clean();
      rec[96] = bad;
      const result = analyze(rec, expected);
      expect(result.anchorCount).toBe(3);
      for (const c of result.clicks) {
        expect(c.confidence).toBeGreaterThan(0.8);
        expect(Math.abs(c.rawMs - 20)).toBeLessThan(0.1);
        expect(Math.abs(c.residualMs)).toBeLessThan(0.1);
      }
    });
  }

  test("a NaN inside a click's own window costs only the lags that overlap it", () => {
    const rec = clean();
    rec[Math.round((expected[1]! + 120) * PER_MS)] = NaN; // 100 ms after the second click, same window
    const result = analyze(rec, expected);
    expect(result.anchorCount).toBe(3);
    expect(Math.abs(result.clicks[1]!.rawMs - 20)).toBeLessThan(0.1);
    for (const c of result.clicks) expect(Number.isFinite(c.residualMs)).toBe(true);
  });

  test("a NaN on top of a click loses that click and nothing else, and never reports a NaN residual", () => {
    const rec = clean();
    rec[Math.round((expected[1]! + 25) * PER_MS)] = NaN; // inside the second click
    const result = analyze(rec, expected);
    expect(result.clicks[1]!.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    expect(result.anchorCount).toBe(2);
    for (const c of result.clicks) {
      expect(Number.isFinite(c.residualMs)).toBe(true); // NaN would serialise to null and fail the whole report
      expect(Number.isFinite(c.confidence)).toBe(true);
    }
    expect(Math.abs(result.clicks[0]!.residualMs)).toBeLessThan(0.1);
    expect(Math.abs(result.clicks[2]!.residualMs)).toBeLessThan(0.1);
  });

  test("near-silence after a loud passage is not turned into a peak by prefix-sum cancellation", () => {
    // 3 s of loud noise, then a window of ~5e-8 "noise" with no click: the old whole-recording prefix sum
    // had an ulp larger than this window's energy, so the denominator was rounding error.
    const rand = rng(3);
    const rec = new Float32Array(Math.round(3.6 * RATE));
    for (let i = 0; i < 3 * RATE; i++) rec[i] = (rand() * 2 - 1) * 0.5;
    for (let i = 3 * RATE; i < rec.length; i++) rec[i] = (rand() * 2 - 1) * 5e-8;
    const c = analyze(rec, [3300]).clicks[0]!;
    expect(c.peak).toBeLessThanOrEqual(1);
    expect(c.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
  });
});

describe("ENGINE-DSP-41: an echo of the click must not veto the click", () => {
  /** One click at `directMs` plus one reflection, in a quiet room (noise 40 dB under the click). */
  const withEcho = (echoDelayMs: number, echoGain: number, seed = 21) => {
    const rec = room(700, 0.002, seed);
    addClick(rec, 310, 0.5);
    addClick(rec, 310 + echoDelayMs, 0.5 * echoGain);
    return analyze(rec, [300]).clicks[0]!;
  };

  test("a reflection 10-20 dB down, anywhere from 5 to 50 ms later, leaves the click confident (was a miss)", () => {
    for (const delay of [5, 12, 20, 30, 50]) {
      for (const gain of [0.1, 0.3]) {
        const c = withEcho(delay, gain);
        expect(Math.abs(c.rawMs - 10)).toBeLessThan(0.1);
        expect(c.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
      }
    }
  });

  test("an inverted reflection (pressure-release surface) is treated the same", () => {
    const c = withEcho(25, -0.3);
    expect(Math.abs(c.rawMs - 10)).toBeLessThan(0.1);
    expect(c.confidence).toBeGreaterThanOrEqual(DEFAULT_MIN_CONFIDENCE);
  });

  test("a reflection nearly as loud as the direct sound stays unconfident: which is which is a guess", () => {
    for (const delay of [5, 20, 30]) expect(withEcho(delay, 0.9).confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
  });

  test("when the LATER arrival is the stronger one, the earlier one still vetoes it (no false accept)", () => {
    // The speaker points away: the reflection is 2x the direct path and 20-30 ms late. Whichever the
    // filter picks, it must not be confident — picking the echo would be a 20-30 ms error, accumulated.
    for (const delay of [20, 30]) {
      const c = withEcho(delay, 2);
      expect(c.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    }
  });

  test("two different phones' clicks in one window are still mutually unconfident", () => {
    // A phone 300 ms late lands in the next phone's window, 100 ms BEFORE that phone's own click and at
    // the same level: outside the echo zone in the direction that matters, so the veto stands.
    const rec = room(2 * INTERVAL + 600, 0.002, 5);
    addClick(rec, 200 + 300, 0.5); // phone 0, 300 ms late
    addClick(rec, 200 + INTERVAL, 0.5); // phone 1, on time
    const result = analyze(rec, [200, 200 + INTERVAL]);
    expect(result.clicks[1]!.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    expect(result.clicks[0]!.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
  });

  test("a window with no click at all is still unconfident over 40 noise seeds", () => {
    let worst = 0;
    for (let seed = 0; seed < 40; seed++) {
      const rec = room(700, 0.02, 100 + seed);
      worst = Math.max(worst, analyze(rec, [300]).clicks[0]!.confidence);
    }
    expect(worst).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
  });
});

describe("ENGINE-DSP-45 (proposed): a click in the wrong slot is attributed to the wrong phone", () => {
  /*
   * The slot is 400 ms and the search window ±150 ms, so a phone 250–550 ms late (a Bluetooth speaker,
   * a bad clock sync) sounds inside the NEXT phone's window. If that phone's own click is absent — its
   * click was skipped as unschedulable (audio.ts `clicksSkipped`), it is muted, it is in a pocket — the
   * late click is the only thing in the window: a clean, confident peak with a −100 ms residual for a
   * phone that never made a sound. Nothing in the loop bounds a residual (reference.ts reports it, the
   * server adds it to calibratedOffsetMs), so the innocent phone is moved by 100 ms and that becomes the
   * base for every later run.
   *
   * The matched filter cannot tell whose click it is; the fix is a plausibility bound where the residual
   * is applied (see the finding). These two tests state the desired outcome and flip when it lands.
   */
  const lateIntoEmptySlot = () => {
    const rec = room(4 * INTERVAL + 600, 0.005, 13);
    addClick(rec, 200, 0.5); // phone 0 on time
    addClick(rec, 200 + INTERVAL + 300, 0.5); // phone 1, 300 ms late: lands at −100 ms in phone 2's window
    // phone 2: silent
    addClick(rec, 200 + 3 * INTERVAL, 0.5); // phone 3 on time
    return analyze(rec, [0, 1, 2, 3].map((k) => 200 + k * INTERVAL));
  };

  test("today: the silent phone is reported 100 ms early with full confidence", () => {
    const result = lateIntoEmptySlot();
    expect(Math.abs(result.clicks[2]!.residualMs + 100)).toBeLessThan(0.5);
    expect(result.clicks[2]!.confidence).toBeGreaterThan(0.8);
    expect(result.anchorCount).toBe(3);
  });

  test.failing("a residual no phone could plausibly have is not reported as confident", () => {
    const result = lateIntoEmptySlot();
    expect(result.clicks[2]!.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
  });
});
