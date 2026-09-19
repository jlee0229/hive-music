/**
 * The calibration click, synthesised from `ClickSpec` — never a fixture (docs/04-calibration.md).
 *
 * Both ends build it: the player to emit it, the reference to correlate against it. They run at
 * different sample rates (44.1 vs 48 kHz), so the *waveform* has to be a function of the spec and the
 * rate alone. The noise burst therefore uses a seeded PRNG with a fixed seed rather than Math.random:
 * a matched filter against different noise finds nothing.
 *
 * Shape: a 2 ms Hann-windowed white-noise burst, then a 20 ms Hann-windowed linear chirp 2 → 6 kHz.
 * The burst gives a sharp correlation peak; the chirp puts enough energy in the band where phone
 * speakers are efficient and phone mics are flat for the peak to survive a noisy room. 22 ms total,
 * far shorter than the 400 ms between clicks.
 */
import type { ClickSpec } from "@hive/protocol";

/** mulberry32 — deterministic, tiny, and identical on every device. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed so that every device synthesises the same noise. Changing it invalidates nothing but is pointless. */
export const CLICK_NOISE_SEED = 0xc11c_c001;

const hann = (i: number, n: number): number => (n <= 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

/**
 * The click waveform at `sampleRate`, peak-normalised to 1 (the caller applies `spec.gain`).
 * Exposed through `client.calibration.renderClick` for the rig and the tests.
 */
export function renderClick(spec: ClickSpec, sampleRate: number): Float32Array {
  const burstLen = Math.max(1, Math.round((spec.burstMs / 1000) * sampleRate));
  const chirpLen = Math.max(1, Math.round((spec.chirpMs / 1000) * sampleRate));
  const out = new Float32Array(burstLen + chirpLen);

  const rand = seeded(CLICK_NOISE_SEED);
  for (let i = 0; i < burstLen; i++) out[i] = (rand() * 2 - 1) * hann(i, burstLen);

  // Linear sweep: instantaneous f(t) = f0 + (f1-f0)·t/T, so the phase is the integral of 2π·f(t).
  const f0 = spec.chirpFromHz;
  const f1 = spec.chirpToHz;
  const tSpan = spec.chirpMs / 1000;
  for (let i = 0; i < chirpLen; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * tSpan));
    out[burstLen + i] = Math.sin(phase) * hann(i, chirpLen);
  }

  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i]! /= peak;
  return out;
}

/** Length of the click in seconds, without rendering it. */
export const clickDurationSec = (spec: ClickSpec): number => (spec.burstMs + spec.chirpMs) / 1000;
