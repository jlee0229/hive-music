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
