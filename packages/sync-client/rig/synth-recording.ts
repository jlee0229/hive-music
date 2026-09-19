#!/usr/bin/env bun
/**
 * Builds a synthetic "room recording" from the real stem, with phones at known offsets — so the rig can
 * be validated against a known answer before anyone trusts it in a venue.
 *
 * A measuring instrument that is quietly wrong is worse than no instrument, and this one is the basis of
 * the project's central claim. Run this, run `measure.ts` on the output, and check it recovers the
 * offsets you asked for.
 *
 *   bun packages/sync-client/rig/synth-recording.ts --out /tmp/two-phones.wav --offsets 0,12 [--noise 0.02]
 *                                                   [--seconds 10] [--stem drums] [--gains 1,0.6]
 */
import { readWav, encodeWav } from "./wav";

const argv = process.argv.slice(2);
const get = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const out = get("out") ?? "/tmp/hive-rig-synth.wav";
const offsetsMs = (get("offsets") ?? "0,12").split(",").map(Number);
const gains = (get("gains") ?? offsetsMs.map(() => "1").join(",")).split(",").map(Number);
const noise = Number(get("noise") ?? 0.02);
const seconds = Number(get("seconds") ?? 10);
const stem = get("stem") ?? "drums";
const fixtures = get("fixtures") ?? `${import.meta.dir}/../../../fixtures/tracks/synthetic-60s`;

const src = await readWav(`${fixtures}/${stem}.wav`);
const rate = src.sampleRate;
const length = Math.min(src.samples.length, Math.round(seconds * rate));

// deterministic pink-ish room noise
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const mix = new Float32Array(length);
let last = 0;
for (let i = 0; i < length; i++) {
  last = 0.96 * last + 0.04 * rand();
  mix[i] = last * noise * 8;
}

// each "phone" is the same stem, shifted by its offset. A positive offset means that phone is LATE.
offsetsMs.forEach((offMs, p) => {
  const shift = Math.round((offMs / 1000) * rate);
  const gain = gains[p] ?? 1;
  for (let i = 0; i < length; i++) {
    const from = i - shift;
    if (from >= 0 && from < src.samples.length) mix[i]! += src.samples[from]! * gain * 0.5;
  }
});

await Bun.write(out, encodeWav(mix, rate));
console.log(`wrote ${out}: ${(length / rate).toFixed(1)} s, ${rate} Hz, ${offsetsMs.length} phones at ${offsetsMs.join(", ")} ms (gains ${gains.join(", ")}), noise ${noise}`);
console.log(`expected spread: ${(Math.max(...offsetsMs) - Math.min(...offsetsMs)).toFixed(2)} ms`);
