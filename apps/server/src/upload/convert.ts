// Normalizes an uploaded stem to the fixtures spec: mono, 16-bit, <=MAX_STEM_SEC. Conversion is
// pure TS — no ffmpeg on Fly. Every stem in one upload is resampled to the same TARGET_SAMPLE_RATE
// (44100, matching every existing fixture) so stems from different source files never end up at
// different rates within one track.
import { parseWav, type ParsedWav } from "./wav";

export const TARGET_SAMPLE_RATE = 44100;
// 10 minutes: the host lobby uploads whole songs now (decoded/downmixed in the browser), not just
// <=60s demo clips. A 600s mono 16-bit WAV is ~53MB in flight — still well under Bun's default
// request-body cap. Mirrored client-side in apps/web/lib/hive/upload-track.ts (MAX_UPLOAD_SEC).
export const MAX_STEM_SEC = 600;

export interface NormalizedStem {
  samples: Float32Array; // mono, in [-1, 1]
  sampleRate: number;
  durationSec: number;
}

function downmix(parsed: ParsedWav): Float32Array {
  if (parsed.numChannels === 1) return parsed.channels[0]!;
  const n = parsed.channels[0]!.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const ch of parsed.channels) sum += ch[i]!;
    out[i] = sum / parsed.numChannels;
  }
  return out;
}

/** Linear-interpolation resample. Adequate for demo-track quality; not a substitute for a real resampler. */
function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = dstRate / srcRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[Math.min(i0, input.length - 1)]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/** Parses, downmixes and resamples a stem to TARGET_SAMPLE_RATE; throws if it exceeds MAX_STEM_SEC. */
export function normalizeStem(buf: Uint8Array): NormalizedStem {
  const parsed = parseWav(buf);
  if (parsed.durationSec > MAX_STEM_SEC) {
    throw new Error(`stem is ${parsed.durationSec.toFixed(1)}s, over the ${MAX_STEM_SEC}s limit`);
  }
  const mono = downmix(parsed);
  const resampled = resampleLinear(mono, parsed.sampleRate, TARGET_SAMPLE_RATE);
  return { samples: resampled, sampleRate: TARGET_SAMPLE_RATE, durationSec: resampled.length / TARGET_SAMPLE_RATE };
}

/** Pads every stem with trailing silence so they share one length (Demucs stems are usually already equal). */
export function alignStemLengths(stems: NormalizedStem[]): void {
  const maxLen = Math.max(...stems.map((s) => s.samples.length));
  for (const s of stems) {
    if (s.samples.length === maxLen) continue;
    const padded = new Float32Array(maxLen);
    padded.set(s.samples);
    s.samples = padded;
    s.durationSec = maxLen / s.sampleRate;
  }
}
