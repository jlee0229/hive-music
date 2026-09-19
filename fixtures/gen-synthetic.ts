/**
 * fixtures/gen-synthetic.ts — writes fixtures/tracks/synthetic-60s/{drums,bass,vocals,other}.wav + meta.json.
 * 16-bit PCM mono 44.1 kHz, exactly 60.0 s, 120 BPM, "drop" at 30 s. Deterministic (seeded LCG noise).
 * No npm deps. Run from the repo root: `bun run fixtures`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const DUR_SEC = 60;
const N = SR * DUR_SEC;
const BPM = 120;
const BEAT_SEC = 60 / BPM; // 0.5 s
const DROP_SEC = 30;
const TWO_PI = 2 * Math.PI;
const TRACK_ID = "synthetic-60s";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "tracks", TRACK_ID);

// Seeded LCG (Numerical Recipes constants) → white noise in [-1, 1). Same bytes every run.
let seed = 0x5eed1234;
function noise(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed / 4294967296) * 2 - 1;
}

// Beat grid (every 0.5 s) and drum-hit grid (beats, then eighth notes from the drop on).
const beatTimes: number[] = [];
for (let i = 0; i * BEAT_SEC < DUR_SEC; i++) beatTimes.push(i * BEAT_SEC);
const hitTimes: number[] = [];
for (let i = 0; i * BEAT_SEC < DROP_SEC; i++) hitTimes.push(i * BEAT_SEC);
for (let i = 0; DROP_SEC + (i * BEAT_SEC) / 2 < DUR_SEC; i++) hitTimes.push(DROP_SEC + (i * BEAT_SEC) / 2);

/** Click on every hit: 2 ms sine burst at 2 kHz + 40 ms decaying white-noise burst. */
function genDrums(): Float32Array {
  const out = new Float32Array(N);
  const clickLen = Math.round(0.002 * SR);
  const noiseLen = Math.round(0.04 * SR);
  const noiseTau = 0.008 * SR; // ~5 time constants inside the 40 ms window
  for (const t of hitTimes) {
    const s0 = Math.round(t * SR);
    for (let k = 0; k < clickLen && s0 + k < N; k++) {
      out[s0 + k] = out[s0 + k]! + Math.sin((TWO_PI * 2000 * k) / SR) * (1 - k / clickLen);
    }
    for (let k = 0; k < noiseLen && s0 + k < N; k++) {
      out[s0 + k] = out[s0 + k]! + 0.6 * noise() * Math.exp(-k / noiseTau);
    }
  }
  return out;
}

/** 55 Hz sine with a per-beat exponential envelope; gain 0.3 before the drop, 0.9 after. */
function genBass(): Float32Array {
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const env = Math.exp(-(t % BEAT_SEC) / 0.12);
    const gain = t < DROP_SEC ? 0.3 : 0.9;
    out[n] = gain * env * Math.sin(TWO_PI * 55 * t);
  }
  return out;
}

/** Slow four-note melody A3 C4 E4 G4 (2 s per note) with 5 Hz vibrato, gain 0.35. */
const MELODY_HZ = [220.0, 261.63, 329.63, 392.0];
function genVocals(): Float32Array {
  const out = new Float32Array(N);
  const noteSec = 2;
  let phase = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const f0 = MELODY_HZ[Math.floor(t / noteSec) % MELODY_HZ.length]!;
    const f = f0 * (1 + 0.012 * Math.sin(TWO_PI * 5 * t)); // ±~20 cents vibrato
    phase += (TWO_PI * f) / SR;
    const tn = t % noteSec;
    const env = Math.min(1, tn / 0.05, (noteSec - tn) / 0.1); // short attack / release, no clicks
    out[n] = 0.35 * env * Math.sin(phase);
  }
  return out;
}

/** Soft pad: two detuned sines (110 Hz, 165 Hz + 0.4 Hz beating) with slow tremolo; 0.12 → 0.5 at the drop. */
function genOther(): Float32Array {
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    const tremolo = 0.8 + 0.2 * Math.sin(TWO_PI * 0.4 * t);
    const ramp = Math.min(1, Math.max(0, (t - DROP_SEC) / 0.05)); // 50 ms ramp so the step is click-free
    const gain = 0.12 + (0.5 - 0.12) * ramp;
    out[n] = gain * tremolo * 0.5 * (Math.sin(TWO_PI * 110 * t) + Math.sin(TWO_PI * 165.4 * t));
  }
  return out;
}

/** Peak-normalize in place to `dbfs` (default −3 dBFS). */
function normalize(x: Float32Array, dbfs = -3): void {
  let peak = 0;
  for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(x[n]!));
  const k = peak > 0 ? Math.pow(10, dbfs / 20) / peak : 1;
  for (let n = 0; n < N; n++) x[n] = x[n]! * k;
}

/** 44-byte RIFF/WAVE header + 16-bit little-endian PCM, mono. */
function toWav(x: Float32Array): Uint8Array {
  const dataBytes = N * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // channels
  v.setUint32(24, SR, true); // sample rate
  v.setUint32(28, SR * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let n = 0; n < N; n++) {
    const s = Math.max(-1, Math.min(1, x[n]!));
    v.setInt16(44 + n * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/** Per-second RMS of the summed stems, normalized so the max is 1.0. */
function energyCurve(stems: Float32Array[]): number[] {
  const rms: number[] = [];
  for (let s = 0; s < DUR_SEC; s++) {
    let acc = 0;
    for (let n = s * SR; n < (s + 1) * SR; n++) {
      let sum = 0;
      for (const stem of stems) sum += stem[n]!;
      acc += sum * sum;
    }
    rms.push(Math.sqrt(acc / SR));
  }
  const max = Math.max(...rms) || 1;
  return rms.map((v) => Number((v / max).toFixed(4)));
}

mkdirSync(OUT_DIR, { recursive: true });
const stems: Record<string, Float32Array> = {
  drums: genDrums(),
  bass: genBass(),
  vocals: genVocals(),
  other: genOther(),
};
const written: string[] = [];
for (const [name, samples] of Object.entries(stems)) {
  normalize(samples);
  const path = join(OUT_DIR, `${name}.wav`);
  writeFileSync(path, toWav(samples));
  written.push(path);
}

const energy = energyCurve(Object.values(stems));
const meta = {
  id: TRACK_ID,
  title: "Synthetic 60",
  durationSec: DUR_SEC,
  sampleRate: SR,
  stems: Object.keys(stems),
  bpm: BPM,
  dropSec: DROP_SEC,
  clickTimesSec: beatTimes,
  energy,
  generated: true,
};
const metaPath = join(OUT_DIR, "meta.json");
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
written.push(metaPath);

console.log(written.join("\n"));
console.log(`energy (${energy.length} values): ${JSON.stringify(energy)}`);
