// Keyword + energy-spike fallback for the Vibe Director (docs/05-effect-modes.md §Rules fallback).
// Runs whenever ANTHROPIC_API_KEY is unset, the LLM call fails or times out, or the model refuses.
import type { ModeKind, Scene } from "@hive/protocol";

export interface TrackMeta {
  durationSec: number;
  energy?: number[];
  dropSec?: number;
}

const KEYWORD_TABLE: Array<{ words: string[]; mode: ModeKind }> = [
  { words: ["calm", "chill", "soft", "slow", "ambient", "intimate", "acoustic"], mode: "UNISON" },
  { words: ["orchestra", "instruments", "band", "spread", "separate", "layers"], mode: "ORCHESTRA" },
  { words: ["stereo", "wide", "left", "right", "image"], mode: "STEREO" },
  { words: ["wave", "ripple", "roll", "sweep", "ocean", "travel"], mode: "WAVE" },
  { words: ["strobe", "flash", "rave", "club", "party", "pulse", "hype"], mode: "STROBE" },
];

function baseMode(prompt: string): ModeKind {
  const p = prompt.toLowerCase();
  for (const entry of KEYWORD_TABLE) if (entry.words.some((w) => p.includes(w))) return entry.mode;
  return "UNISON";
}

/** Smooth energy[] with a 3-point moving average, then find the biggest rise (after − before) over a short window. */
function detectDrop(meta: TrackMeta): number | null {
  if (typeof meta.dropSec === "number") return meta.dropSec;
  const energy = meta.energy;
  if (!energy || energy.length < 8) return null;
  const smooth = energy.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(energy.length - 1, i + 1);
    let sum = 0;
    let n = 0;
    for (let k = lo; k <= hi; k++) {
      sum += energy[k]!;
      n++;
    }
    return sum / n;
  });
  let bestT = -1;
  let bestRise = 0;
  for (let t = 4; t < smooth.length - 2; t++) {
    const after = (smooth[t]! + smooth[t + 1]! + smooth[t + 2]!) / 3;
    const before = (smooth[t - 4]! + smooth[t - 3]! + smooth[t - 2]! + smooth[t - 1]!) / 4;
    const rise = after - before;
    if (rise > bestRise) {
      bestRise = rise;
      bestT = t;
    }
  }
  return bestRise > 0.2 ? bestT : null;
}

function note(s: string): string {
  return s.length > 40 ? s.slice(0, 40) : s;
}

export function rulesFallback(prompt: string, meta: TrackMeta): Scene[] {
  const base = baseMode(prompt);
  const p = prompt.toLowerCase();
  const drop = detectDrop(meta);

  if (drop !== null) {
    const peakMode: ModeKind = /strobe|flash|rave/.test(p) ? "STROBE" : "WAVE";
    const scenes: Scene[] = [
      { atTrackSec: 0, mode: base, params: {}, note: note("calm") },
      { atTrackSec: drop, mode: peakMode, params: peakMode === "WAVE" ? { axis: "x", spanMs: 240 } : {}, note: note("drop") },
    ];
    if (drop + 16 < meta.durationSec) scenes.push({ atTrackSec: drop + 16, mode: base, params: {}, note: note("settle") });
    return scenes;
  }
  if (/change|then/.test(p)) {
    return [
      { atTrackSec: 0, mode: base, params: {}, note: note("open") },
      { atTrackSec: meta.durationSec / 2, mode: "ORCHESTRA", params: {}, note: note("build") },
    ];
  }
  return [{ atTrackSec: 0, mode: base, params: {}, note: note("open") }];
}
