// Builds fixtures/tracks/<id>/meta.json for an uploaded track the same way fixtures/gen-synthetic.ts
// does for the synthetic one: per-second energy[], a detected dropSec, durationSec.
import { detectDropFromEnergy, energyCurve } from "../vibe/energy";
import type { NormalizedStem } from "./convert";

export interface UploadedTrackMeta {
  id: string;
  title: string;
  durationSec: number;
  sampleRate: number;
  stems: string[];
  energy: number[];
  dropSec?: number;
  generated: false;
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
  return {
    id,
    title,
    durationSec,
    sampleRate,
    stems: stemNames,
    energy,
    ...(dropSec !== null ? { dropSec } : {}),
    generated: false,
  };
}
