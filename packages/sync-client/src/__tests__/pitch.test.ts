import { describe, expect, test } from "bun:test";
import { pitchShiftMono } from "../pitch";

const RATE = 44100;

function sine(hz: number, seconds: number): Float32Array {
  const n = Math.floor(RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / RATE) * 0.5;
  return out;
}

/** Positive-going zero crossings per second over the settled middle of the signal. */
function frequencyOf(samples: Float32Array): number {
  const from = Math.floor(samples.length * 0.25);
  const to = Math.floor(samples.length * 0.75);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
  return crossings / ((to - from) / RATE);
}

describe("pitchShiftMono (CHOIR)", () => {
  test("+12 semitones doubles the frequency and preserves the duration exactly", async () => {
    const input = sine(440, 2);
    const out = await pitchShiftMono(input, 12);
    expect(out.length).toBe(input.length); // the timeline mapping depends on this
    expect(frequencyOf(out)).toBeGreaterThan(880 * 0.94);
    expect(frequencyOf(out)).toBeLessThan(880 * 1.06);
  });

  test("-12 semitones halves the frequency", async () => {
    const input = sine(440, 2);
    const out = await pitchShiftMono(input, -12);
    expect(out.length).toBe(input.length);
    expect(frequencyOf(out)).toBeGreaterThan(220 * 0.94);
    expect(frequencyOf(out)).toBeLessThan(220 * 1.06);
  });

  test("0 semitones is a pass-through", async () => {
    const input = sine(440, 0.5);
    expect(await pitchShiftMono(input, 0)).toBe(input);
  });
});
