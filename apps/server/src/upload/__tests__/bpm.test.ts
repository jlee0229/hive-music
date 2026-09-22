import { describe, expect, test } from "bun:test";
import { detectBpm } from "../bpm";

const RATE = 44100;

/** A kick-drum-ish click train: decaying 60 Hz thumps on every beat, light noise between. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const n = RATE * seconds;
  const out = new Float32Array(n);
  const beat = (60 / bpm) * RATE;
  for (let i = 0; i < n; i++) out[i] = (Math.random() - 0.5) * 0.02;
  for (let b = 0; b * beat < n; b++) {
    const start = Math.round(b * beat);
    for (let i = 0; i < 4000 && start + i < n; i++) {
      out[start + i] = out[start + i]! + Math.sin((2 * Math.PI * 60 * i) / RATE) * Math.exp(-i / 800) * 0.8;
    }
  }
  return out;
}

describe("detectBpm", () => {
  test("finds 128 BPM in a click track within a beat-per-minute", () => {
    const bpm = detectBpm(clickTrack(128, 30), RATE);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 128)).toBeLessThan(1.5);
  });

  test("finds a slow tempo too (85 BPM)", () => {
    const bpm = detectBpm(clickTrack(85, 30), RATE);
    expect(bpm).not.toBeNull();
    expect(Math.abs(bpm! - 85)).toBeLessThan(1.5);
  });

  test("silence and too-short audio return null", () => {
    expect(detectBpm(new Float32Array(RATE * 30), RATE)).toBeNull();
    expect(detectBpm(clickTrack(120, 5), RATE)).toBeNull();
  });
});
