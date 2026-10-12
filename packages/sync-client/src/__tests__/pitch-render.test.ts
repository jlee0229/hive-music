/**
 * CHOIR render properties the length/frequency test in pitch.test.ts cannot see: a pitched copy has
 * to stay on the shared timeline (same onsets at the same sample positions as the original), not
 * merely have the same length.
 */
import { describe, expect, test } from "bun:test";
import { pitchShiftMono } from "../pitch";

const RATE = 44100;

/** Deterministic PRNG (mulberry32) so every run measures the same signal. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Music-like: 120 BPM kick, snare and hat noise bursts, a bass note, a chord and a noise floor. */
function musicLike(seconds: number): Float32Array {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  const r = rng(1);
  const beat = Math.floor(RATE * 0.5);
  const chord = [220, 277.18, 329.63, 440];
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const bt = (i % beat) / RATE;
    let s = 0.5 * Math.exp(-bt / 0.05) * Math.sin(2 * Math.PI * (50 * bt + 60 * 0.03 * (1 - Math.exp(-bt / 0.03))));
    if (Math.floor(i / beat) % 2 === 1) s += 0.3 * Math.exp(-bt / 0.04) * (r() * 2 - 1);
    s += 0.08 * Math.exp(-((i % (beat >> 1)) / RATE) / 0.01) * (r() * 2 - 1);
    s += 0.15 * Math.sin(2 * Math.PI * 55 * t);
    for (const f of chord) s += 0.05 * Math.sin(2 * Math.PI * f * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.3 * t));
    out[i] = s + 0.01 * (r() * 2 - 1);
  }
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let e = 0;
  for (let i = from; i < to; i++) e += x[i]! * x[i]!;
  return Math.sqrt(e / Math.max(1, to - from));
}

/** Rectified, boxcar-smoothed (`win` samples) envelope sampled every `hop` samples. */
function envelope(x: Float32Array, hop: number, win: number): Float32Array {
  const sums = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sums[i + 1] = sums[i]! + Math.abs(x[i]!);
  const env = new Float32Array(Math.floor(x.length / hop));
  for (let j = 0; j < env.length; j++) {
    const a = Math.max(0, j * hop - (win >> 1));
    const b = Math.min(x.length, j * hop + (win >> 1));
    env[j] = (sums[b]! - sums[a]!) / (b - a);
  }
  return env;
}

/**
 * Lag of `y` behind `x` in samples (negative = `y` is early): the shift that maximises the
 * normalised cross-correlation of the two amplitude envelopes over x[from..to). A pitch shift
 * changes the waveform but not when things happen, so the envelopes are what must line up.
 */
function envelopeLag(x: Float32Array, y: Float32Array, from: number, to: number, maxLag: number): number {
  const hop = 8;
  const ex = envelope(x, hop, 256);
  const ey = envelope(y, hop, 256);
  const f = Math.floor(from / hop);
  const t = Math.floor(to / hop);
  const span = Math.floor(maxLag / hop);
  let best = -Infinity;
  let bestLag = 0;
  for (let l = -span; l <= span; l++) {
    let sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
    for (let i = f; i < t; i++) {
      const u = ex[i]!, v = ey[i + l]!;
      sxy += u * v; sx += u; sy += v; sxx += u * u; syy += v * v;
    }
    const n = t - f;
    const c = (sxy - (sx * sy) / n) / Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n) + 1e-30);
    if (c > best) {
      best = c;
      bestLag = l * hop;
    }
  }
  return bestLag;
}

describe("pitchShiftMono stays on the shared timeline (ENGINE-DSP-20)", () => {
  const input = musicLike(30);
  // The room's whole sync budget is 25 ms. Unfixed, the render alone is 43 ms early at +12, 34 ms
  // early at +7 and 22 ms late at -12; WSOLA's signal-dependent seek leaves about ±5 ms after the fix.
  const TOLERANCE = Math.round(0.01 * RATE);
  for (const semitones of [12, -12, 7]) {
    test(`${semitones > 0 ? "+" : ""}${semitones} semitones: events land where they were, start and end of the track`, async () => {
      const out = await pitchShiftMono(input, semitones);
      expect(out.length).toBe(input.length);
      const early = envelopeLag(input, out, 1 * RATE, 14 * RATE, 3000);
      const late = envelopeLag(input, out, 16 * RATE, 29 * RATE, 3000);
      if (process.env.PITCH_DEBUG) console.log(`semitones ${semitones}: lag ${early} / ${late} samples`);
      expect(Math.abs(early)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(late)).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});
