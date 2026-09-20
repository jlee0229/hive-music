// Keyword + energy-spike fallback for the Vibe Director (docs/05-effect-modes.md §Rules fallback).
// Runs whenever ANTHROPIC_API_KEY is unset, the LLM call fails or times out, or the model refuses.
import type { ModeKind, Scene } from "@hive/protocol";
import { detectDropFromEnergy } from "./energy";

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

function detectDrop(meta: TrackMeta): number | null {
  if (typeof meta.dropSec === "number") return meta.dropSec;
  return detectDropFromEnergy(meta.energy);
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
