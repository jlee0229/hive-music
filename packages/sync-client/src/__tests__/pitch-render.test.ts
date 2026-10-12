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

describe("pitchShiftMono renders the whole clip (ENGINE-DSP-21)", () => {
  for (const semitones of [12, -12, 7]) {
    test(`${semitones > 0 ? "+" : ""}${semitones} semitones: the last 100 ms are audio, not zeros`, async () => {
      const input = musicLike(4);
      const out = await pitchShiftMono(input, semitones);
      expect(out.length).toBe(input.length);
      const from = input.length - Math.round(0.1 * RATE);
      // Unfixed: 0.24-0.44 s of exact zeros at the end of every render (rms 0).
      expect(rms(out, from)).toBeGreaterThan(0.5 * rms(input, from));
    });
  }

  test("a clip shorter than SoundTouch's 16384-frame input block is still rendered", async () => {
    const input = musicLike(0.25); // 11025 samples; unfixed this comes back as pure silence
    for (const semitones of [12, -12, 7]) {
      const out = await pitchShiftMono(input, semitones);
      expect(out.length).toBe(input.length);
      expect(rms(out)).toBeGreaterThan(0.5 * rms(input));
    }
  });

  test("an empty clip stays empty", async () => {
    expect((await pitchShiftMono(new Float32Array(0), 12)).length).toBe(0);
  });
});

describe("pitchShiftMono never emits or hangs on non-finite numbers (ENGINE-DSP-22)", () => {
  test("every rendered sample is finite (soundtouchjs's quick seek can pick offset -1)", async () => {
    // -14 st on this signal is a deterministic hit: unfixed, sample 719952 of the raw render is NaN.
    // The same path is live at CHOIR's -12 (102 negative seek offsets in a 4-minute render).
    const out = await pitchShiftMono(musicLike(20), -14);
    let bad = 0;
    for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i]!)) bad++;
    expect(bad).toBe(0);
  });

  test("a non-finite shift is a pass-through, not an endless synchronous loop", async () => {
    const input = musicLike(0.5);
    // Unfixed, +Infinity never returns: tempo becomes 0 and the stretcher stops consuming input.
    expect(await pitchShiftMono(input, Number.POSITIVE_INFINITY)).toBe(input);
    expect(await pitchShiftMono(input, Number.NEGATIVE_INFINITY)).toBe(input);
    expect(await pitchShiftMono(input, Number.NaN)).toBe(input);
  });
});

describe("pitchShiftMono shares the main thread (ENGINE-DSP-23)", () => {
  test("yields after every 16384-frame block, not every 5 s of audio", async () => {
    const input = musicLike(20);
    let yields = 0;
    await pitchShiftMono(input, 12, {
      yieldToEventLoop: async () => {
        yields++;
      },
    });
    // 20 s is 53 blocks. Unfixed: one slice per 5 s of audio (3 yields), 25-44 ms of blocked main
    // thread on a desktop and ten times that on a phone.
    expect(yields).toBeGreaterThanOrEqual(Math.floor(input.length / 16384) - 1);
  });

  test("timers still get their turn during a render with the default yield", async () => {
    // The default yield is a MessageChannel hop, and a runtime may serve messages ahead of due
    // timers (Bun does: 0 turns here without the periodic timer hop). The engine's scheduler and
    // watchdog run on timers, so every 16th slice must be a real one: 53 blocks -> 3 turns.
    let turns = 0;
    const timer = setInterval(() => turns++, 1);
    try {
      await pitchShiftMono(musicLike(20), -12);
    } finally {
      clearInterval(timer);
    }
    expect(turns).toBeGreaterThanOrEqual(2);
  });

  test("an aborted render rejects at the next slice instead of finishing a stale buffer", async () => {
    const signal = { aborted: false };
    let yields = 0;
    const render = pitchShiftMono(musicLike(20), 7, {
      signal,
      yieldToEventLoop: async () => {
        if (++yields === 3) signal.aborted = true;
      },
    });
    await expect(render).rejects.toThrow("aborted");
    expect(yields).toBe(3);
  });
});
