import { describe, expect, test } from "bun:test";
import { alignStemLengths, normalizeStem, MAX_STEM_SEC, TARGET_SAMPLE_RATE } from "../convert";
import { encodeMonoWav16 } from "../wav";

function synthWav(n: number, hz: number, sampleRate: number): Uint8Array {
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5;
  return encodeMonoWav16(samples, sampleRate);
}

describe("normalizeStem", () => {
  test("keeps a 44100Hz mono file at 44100Hz", () => {
    const wav = synthWav(44100, 440, 44100);
    const stem = normalizeStem(wav);
    expect(stem.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(stem.samples.length).toBe(44100);
    expect(stem.durationSec).toBeCloseTo(1, 2);
  });

  test("resamples a 22050Hz file up to the target rate, preserving duration", () => {
    const wav = synthWav(22050, 220, 22050); // 1 second at 22050Hz
    const stem = normalizeStem(wav);
    expect(stem.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(stem.durationSec).toBeCloseTo(1, 1);
    expect(stem.samples.length).toBeCloseTo(TARGET_SAMPLE_RATE, -2);
  });

  test("resamples a 48000Hz file down to the target rate", () => {
    const wav = synthWav(48000, 440, 48000); // 1 second at 48000Hz
    const stem = normalizeStem(wav);
    expect(stem.sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(stem.durationSec).toBeCloseTo(1, 1);
  });

  test("rejects a stem longer than MAX_STEM_SEC with a clear error", () => {
    const wav = synthWav(44100 * (MAX_STEM_SEC + 1), 440, 44100);
    expect(() => normalizeStem(wav)).toThrow(new RegExp(`over the ${MAX_STEM_SEC}s limit`));
  });
});

describe("alignStemLengths", () => {
  test("pads shorter stems with trailing silence to match the longest", () => {
    const a = normalizeStem(synthWav(44100, 440, 44100)); // 1.0s
    const b = normalizeStem(synthWav(22050, 220, 44100)); // 0.5s
    alignStemLengths([a, b]);
    expect(a.samples.length).toBe(b.samples.length);
    expect(b.samples.length).toBe(44100);
    expect(b.samples[43000]).toBe(0); // padded silence
    expect(b.durationSec).toBeCloseTo(1, 2);
  });

  test("is a no-op when every stem is already the same length", () => {
    const a = normalizeStem(synthWav(44100, 440, 44100));
    const b = normalizeStem(synthWav(44100, 220, 44100));
    const beforeLenA = a.samples.length;
    alignStemLengths([a, b]);
    expect(a.samples.length).toBe(beforeLenA);
  });
});
