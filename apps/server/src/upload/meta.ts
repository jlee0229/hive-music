// Builds fixtures/tracks/<id>/meta.json for an uploaded track the same way fixtures/gen-synthetic.ts
// does for the synthetic one: per-second energy[], a detected dropSec, a detected bpm, durationSec.
import { detectDropFromEnergy, energyCurve } from "../vibe/energy";
import { detectBpm } from "./bpm";
import type { NormalizedStem } from "./convert";

export interface UploadedTrackMeta {
  id: string;
  title: string;
  durationSec: number;
  sampleRate: number;
  stems: string[];
  energy: number[];
  dropSec?: number;
  /** Detected tempo; drives the beat-locked STROBE. Absent when detection found nothing usable. */
  bpm?: number;
  generated: false;
}

/** Sum the stems into one mixdown for tempo analysis (a "mix" upload is already the mixdown). */
function mixdown(stems: NormalizedStem[]): Float32Array {
  if (stems.length === 1) return stems[0]!.samples;
  const n = Math.max(...stems.map((s) => s.samples.length));
  const out = new Float32Array(n);
  for (const s of stems) for (let i = 0; i < s.samples.length; i++) out[i] = (out[i] ?? 0) + s.samples[i]!;
  return out;
}

export function buildTrackMeta(id: string, title: string, stemNames: string[], stems: NormalizedStem[]): UploadedTrackMeta {
  const sampleRate = stems[0]!.sampleRate;
  const durationSec = stems[0]!.durationSec;
  const energy = energyCurve(
    stems.map((s) => s.samples),
    sampleRate,
    durationSec,
  );
  const dropSec = detectDropFromEnergy(energy);
  const bpm = detectBpm(mixdown(stems), sampleRate);
  return {
    id,
    title,
    durationSec,
    sampleRate,
    stems: stemNames,
    energy,
    ...(dropSec !== null ? { dropSec } : {}),
    ...(bpm !== null ? { bpm } : {}),
    generated: false,
  };
}
