#!/usr/bin/env bun
/**
 * Tempo / beat-grid evaluation harness for `src/upload/bpm.ts`.
 *
 *   bun apps/server/scripts/bpm-eval.ts                 # full synthetic corpus, per-style scorecard
 *   bun apps/server/scripts/bpm-eval.ts --quick         # 4 tracks per style
 *   bun apps/server/scripts/bpm-eval.ts --perf          # time + memory on a 4-minute track
 *   bun apps/server/scripts/bpm-eval.ts --detector <module.ts>   # score another detector (A/B)
 *   bun apps/server/scripts/bpm-eval.ts --no-corpus song.wav:128 other.wav:65   # held-out real files
 *
 * The strobe switches phone groups on the detected grid, so what matters is not "is the BPM close"
 * but "does a grid at (bpm, beatOffsetSec) land on the drum hits for the whole song":
 *   - exact   — within ±1.5 BPM of the true tempo
 *   - octave  — 2× or ½× (fine for a strobe: every switch still lands on a beat or half-beat)
 *   - BAD     — 4/3, 3/4, 2/3, 3/2 (the dotted-rhythm impostors: the grid walks through the bar)
 *   - triple / other — everything else
 *   - offset  — signed distance from the detected grid to the true beats at t=0 (ms)
 *   - slide   — how far that grid has walked off the beats 240 s in, from the tempo error alone
 *
 * The corpus is synthesized (seeded, so every run is identical): kick / snare / hats / bass / chord
 * stabs / pads / wandering "vocal" notes, in styles chosen to include the rhythms that fool
 * autocorrelation — 3-3-2 tresillos, dotted-eighth stabs, dembow, off-beat skanks, swing, 12/8.
 * No audio files are read unless paths are passed on the command line, and none are written.
 */
import { detectBeatGrid as currentDetector, BPM_ALGORITHM_VERSION } from "../src/upload/bpm";
import { parseWav } from "../src/upload/wav";

// ---------------------------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------------------------

export type Style =
  | "four_floor" | "backbeat" | "slow_16hats" | "tresillo" | "dotted16" | "dotted_run" | "dembow"
  | "skank_pop" | "swing" | "shuffle_12_8" | "trap_halftime" | "ballad" | "offbeat_house"
  | "funk_break" | "arp_no_drums";

export interface TrackSpec {
  id: string;
  style: Style;
  /** True tempo. 2× and ½× are scored as acceptable; see the header. */
  bpm: number;
  /** Time of the first downbeat, seconds. The true beat grid is firstBeatSec + k·60/bpm for all k. */
  firstBeatSec: number;
  durationSec: number;
  sampleRate: number;
  /** Broadband noise floor relative to the music's RMS. */
  snrDb: number;
  intro: "none" | "silence" | "pad" | "pickup";
  /** Uniform ± humanisation applied to every hit. */
  jitterMs: number;
  breakdown: boolean;
  seed: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Hit = [step: number, vel: number, lenSteps?: number];
interface Pattern {
  /** Steps per 4-beat bar: 16 (sixteenths) or 12 (triplet eighths). */
  steps: 16 | 12;
  kick?: Hit[];
  snare?: Hit[];
  hat?: Hit[];
  ohat?: Hit[];
  bass?: Hit[];
  stab?: Hit[];
  /** Fraction of a beat by which off-beat eighths are delayed (0.167 = triplet swing). */
  swing?: number;
  /** Relative levels; each is additionally randomised ±30 % per track. */
  level: { drums: number; bass: number; stab: number; pad: number; vocal: number };
  bpmRange: [number, number];
}

const every = (from: number, step: number, to: number, vel: number, len?: number): Hit[] => {
  const out: Hit[] = [];
  for (let s = from; s < to; s += step) out.push(len === undefined ? [s, vel] : [s, vel, len]);
  return out;
};

/** Each style returns one of a few variants, so a style is a family rather than a single loop. */
const STYLES: Record<Style, (pick: (n: number) => number) => Pattern> = {
  four_floor: (pick) => ({
    steps: 16,
    kick: every(0, 4, 16, 1),
    snare: [[4, 0.6], [12, 0.6]],
    ohat: every(2, 4, 16, 0.5),
    hat: every(0, 1, 16, 0.18),
    bass: every(2, 4, 16, 0.7, 2),
    stab: pick(2) ? [[0, 0.6, 2]] : [[0, 0.6, 2], [3, 0.5, 2], [6, 0.5, 2]],
    level: { drums: 1, bass: 0.6, stab: 0.4, pad: 0.25, vocal: 0.3 },
    bpmRange: [100, 150],
  }),
  backbeat: (pick) => ({
    steps: 16,
    kick: [[0, 1], [8, 0.9], [[10, 6, 7][pick(3)]!, 0.6]],
    snare: [[4, 0.9], [12, 0.9]],
    hat: every(0, 2, 16, 0.4),
    bass: [[0, 0.8, 2], [8, 0.8, 2], [10, 0.6, 2], [14, 0.5, 2]],
    stab: pick(2) ? [[0, 0.5, 4], [8, 0.5, 4]] : [],
    level: { drums: 1, bass: 0.6, stab: 0.4, pad: 0.3, vocal: 0.4 },
    bpmRange: [70, 185],
  }),
  slow_16hats: () => ({
    steps: 16,
    kick: [[0, 1], [7, 0.6], [10, 0.8]],
    snare: [[4, 0.9], [12, 0.9]],
    hat: [...every(0, 2, 16, 0.45), ...every(1, 2, 16, 0.25)],
    bass: [[0, 0.8, 3], [7, 0.6, 2], [10, 0.7, 3]],
    level: { drums: 1, bass: 0.7, stab: 0, pad: 0.35, vocal: 0.4 },
    bpmRange: [60, 95],
  }),
  // 3-3-2 over the bar in eighths: hits 1.5 beats apart → the 2/3× (and, via its half, 4/3×) impostor.
  tresillo: (pick) => ({
    steps: 16,
    kick: [[0, 1], [6, 0.9], [12, 0.9]],
    snare: pick(2) ? [[4, 0.5], [12, 0.5]] : [[8, 0.7]],
    hat: every(0, 2, 16, 0.3),
    bass: [[0, 0.9, 4], [6, 0.9, 4], [12, 0.9, 3]],
    stab: [[0, 0.7, 3], [6, 0.7, 3], [12, 0.7, 3]],
    level: { drums: 0.9, bass: 0.8, stab: 0.6, pad: 0.3, vocal: 0.3 },
    bpmRange: [85, 150],
  }),
  // 3-3-2 in sixteenths, twice a bar: hits 0.75 beats apart → the 4/3× impostor (the production bug).
  dotted16: (pick) => ({
    steps: 16,
    kick: pick(2) ? [[0, 1], [8, 0.9]] : [[0, 1], [3, 0.6], [6, 0.6], [8, 0.9], [11, 0.6], [14, 0.6]],
    snare: [[4, 0.8], [12, 0.8]],
    hat: every(0, 2, 16, 0.3),
    bass: [[0, 0.9, 2], [3, 0.9, 2], [6, 0.9, 2], [8, 0.9, 2], [11, 0.9, 2], [14, 0.9, 2]],
    stab: [[0, 0.8, 2], [3, 0.8, 2], [6, 0.8, 2], [8, 0.8, 2], [11, 0.8, 2], [14, 0.8, 2]],
    level: { drums: 0.8, bass: 0.8, stab: 0.8, pad: 0.3, vocal: 0.3 },
    bpmRange: [60, 110],
  }),
  // An unbroken dotted-eighth run against a plain backbeat (the "3 against 4" synth hook).
  dotted_run: (pick) => ({
    steps: 16,
    kick: pick(2) ? [[0, 1], [8, 0.9]] : every(0, 4, 16, 0.9),
    snare: [[4, 0.7], [12, 0.7]],
    hat: every(2, 4, 16, 0.3),
    stab: [[0, 0.9, 2], [3, 0.9, 2], [6, 0.9, 2], [9, 0.9, 2], [12, 0.9, 2], [15, 0.6, 1]],
    bass: [[0, 0.9, 3], [3, 0.7, 3], [6, 0.7, 2], [8, 0.9, 3], [11, 0.7, 3], [14, 0.7, 2]],
    level: { drums: 0.7, bass: 0.8, stab: 0.9, pad: 0.3, vocal: 0.3 },
    bpmRange: [60, 115],
  }),
  dembow: () => ({
    steps: 16,
    kick: every(0, 4, 16, 1),
    snare: [[3, 0.8], [6, 0.8], [11, 0.8], [14, 0.8]],
    hat: every(0, 2, 16, 0.25),
    bass: [[0, 0.9, 3], [3, 0.7, 3], [6, 0.7, 2], [8, 0.9, 3], [11, 0.7, 3], [14, 0.7, 2]],
    level: { drums: 1, bass: 0.7, stab: 0, pad: 0.3, vocal: 0.4 },
    bpmRange: [85, 110],
  }),
  // Syncopated kick, off-beat guitar skank, dotted bass — "Party in the U.S.A." territory.
  skank_pop: () => ({
    steps: 16,
    kick: [[0, 1], [3, 0.5], [8, 0.9], [10, 0.6]],
    snare: [[4, 0.8], [12, 0.8]],
    hat: every(0, 2, 16, 0.25),
    stab: every(2, 4, 16, 0.9, 1),
    bass: [[0, 0.9, 2], [3, 0.8, 2], [6, 0.8, 2], [8, 0.9, 2], [11, 0.8, 2], [14, 0.8, 2]],
    level: { drums: 0.8, bass: 0.8, stab: 0.8, pad: 0.25, vocal: 0.4 },
    bpmRange: [75, 112],
  }),
  swing: () => ({
    steps: 16,
    swing: 1 / 6,
    kick: [[0, 0.7], [8, 0.6]],
    snare: [[4, 0.6], [12, 0.6]],
    hat: [[0, 0.5], [4, 0.6], [6, 0.4], [8, 0.5], [12, 0.6], [14, 0.4]],
    bass: every(0, 4, 16, 0.8, 3),
    stab: [[6, 0.5, 2], [14, 0.4, 2]],
    level: { drums: 0.8, bass: 0.8, stab: 0.5, pad: 0.2, vocal: 0.4 },
    bpmRange: [90, 180],
  }),
  shuffle_12_8: (pick) => ({
    steps: 12,
    kick: pick(2) ? [[0, 1], [6, 0.9]] : [[0, 1], [5, 0.5], [6, 0.9]],
    snare: [[3, 0.9], [9, 0.9]],
    hat: [...every(0, 3, 12, 0.5), ...every(1, 3, 12, 0.3), ...every(2, 3, 12, 0.35)],
    bass: [[0, 0.8, 2], [2, 0.5, 1], [3, 0.7, 2], [6, 0.8, 2], [8, 0.5, 1], [9, 0.7, 2]],
    level: { drums: 1, bass: 0.7, stab: 0, pad: 0.3, vocal: 0.4 },
    bpmRange: [60, 125],
  }),
  // Snare on beat 3 only, busy hats, long 808 notes. Truth is the bar's quarter note.
  trap_halftime: () => ({
    steps: 16,
    kick: [[0, 1], [6, 0.8], [10, 0.7]],
    snare: [[8, 1]],
    hat: [...every(0, 2, 16, 0.4), [3, 0.25], [13, 0.25], [15, 0.3]],
    bass: [[0, 1, 5], [6, 0.9, 4], [10, 0.8, 5]],
    level: { drums: 1, bass: 0.9, stab: 0, pad: 0.3, vocal: 0.4 },
    bpmRange: [120, 180],
  }),
  // Quiet drums under loud soft-attack material.
  ballad: () => ({
    steps: 16,
    kick: [[0, 0.7], [8, 0.6]],
    snare: [[4, 0.5], [12, 0.5]],
    hat: every(0, 2, 16, 0.15),
    stab: every(0, 4, 16, 0.6, 4),
    bass: [[0, 0.7, 8], [8, 0.7, 8]],
    level: { drums: 0.45, bass: 0.6, stab: 0.6, pad: 0.6, vocal: 0.7 },
    bpmRange: [60, 95],
  }),
  // The kick is on the beat but the loudest things in the bar are off it: a phase trap.
  offbeat_house: () => ({
    steps: 16,
    kick: every(0, 4, 16, 0.9),
    snare: [[4, 0.5], [12, 0.5]],
    ohat: every(2, 4, 16, 1),
    bass: every(2, 4, 16, 1, 2),
    stab: every(2, 4, 16, 0.6, 1),
    level: { drums: 1, bass: 0.8, stab: 0.5, pad: 0.25, vocal: 0.3 },
    bpmRange: [116, 134],
  }),
  funk_break: () => ({
    steps: 16,
    kick: [[0, 1], [3, 0.5], [10, 0.9]],
    snare: [[4, 0.9], [7, 0.25], [9, 0.25], [12, 0.9]],
    hat: [...every(0, 2, 16, 0.45), ...every(1, 2, 16, 0.2)],
    bass: [[0, 0.9, 2], [3, 0.7, 2], [6, 0.7, 2], [10, 0.8, 2], [13, 0.7, 2]],
    level: { drums: 1, bass: 0.8, stab: 0, pad: 0.2, vocal: 0.4 },
    bpmRange: [85, 125],
  }),
  // No percussion at all: only pitched onsets, accented 3-3-2.
  arp_no_drums: () => ({
    steps: 16,
    stab: every(0, 1, 16, 0.35, 1).map(([s, v, l]) => [s, [0, 3, 6, 8, 11, 14].includes(s) ? 0.9 : v, l] as Hit),
    bass: [[0, 0.9, 6], [8, 0.9, 6]],
    level: { drums: 0, bass: 0.8, stab: 0.8, pad: 0.4, vocal: 0.2 },
    bpmRange: [80, 140],
  }),
};

export const ALL_STYLES = Object.keys(STYLES) as Style[];

/** Four-chord loop, one chord per bar; values are semitones above the key's root. */
const PROGRESSIONS = [
  [0, 8, 3, 10], // i VI III VII
  [0, 5, 7, 5], // I IV V IV
  [0, 9, 5, 7], // I vi IV V
  [0, 0, 5, 7],
];
const hz = (semitonesFromA2: number) => 110 * 2 ** (semitonesFromA2 / 12);

export function renderTrack(spec: TrackSpec): Float32Array {
  const rate = spec.sampleRate;
  const n = Math.floor(spec.durationSec * rate);
  const out = new Float32Array(n);
  const rand = mulberry32(spec.seed);
  const pick = (k: number) => Math.floor(rand() * k);
  const pat = STYLES[spec.style](pick);
  const lvl = (base: number) => base * (0.7 + 0.6 * rand());
  const L = { drums: lvl(pat.level.drums), bass: lvl(pat.level.bass), stab: lvl(pat.level.stab), pad: lvl(pat.level.pad), vocal: lvl(pat.level.vocal) };
  const beat = 60 / spec.bpm;
  const bar = 4 * beat;
  const stepSec = bar / pat.steps;
  const key = pick(12) - 12;
  const prog = PROGRESSIONS[pick(PROGRESSIONS.length)]!;
  const jitter = () => ((rand() * 2 - 1) * spec.jitterMs) / 1000;
  const noise = mulberry32(spec.seed ^ 0x9e3779b9);

  const stepTime = (barStart: number, step: number): number => {
    let t = barStart + step * stepSec;
    // swing delays the off-beat eighth (steps 2, 6, 10, 14 of a sixteenth grid)
    if (pat.swing && pat.steps === 16 && step % 4 === 2) t += pat.swing * beat;
    return t + jitter();
  };

  const add = (t0: number, len: number, fn: (i: number, t: number) => number) => {
    const start = Math.round(t0 * rate);
    const count = Math.round(len * rate);
    for (let i = 0; i < count; i++) {
      const at = start + i;
      if (at < 0) continue;
      if (at >= n) break;
      out[at] = out[at]! + fn(i, i / rate);
    }
  };
  const kick = (t0: number, vel: number) => {
    let phase = 0;
    add(t0, 0.3, (i, t) => {
      phase += (2 * Math.PI * (48 + 120 * Math.exp(-t / 0.025))) / rate;
      const click = i < rate * 0.002 ? (noise() * 2 - 1) * 0.4 : 0;
      return (Math.sin(phase) * Math.exp(-t / 0.09) + click) * vel * 0.9;
    });
  };
  const snare = (t0: number, vel: number) => {
    let prev = 0;
    add(t0, 0.2, (_i, t) => {
      const w = noise() * 2 - 1;
      const hp = w - 0.5 * prev;
      prev = w;
      return (hp * Math.exp(-t / 0.05) * 0.7 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.04) * 0.5) * vel * 0.7;
    });
  };
  const hat = (t0: number, vel: number, open: boolean) => {
    let p1 = 0;
    let p2 = 0;
    const tau = open ? 0.08 : 0.012;
    add(t0, open ? 0.3 : 0.06, (_i, t) => {
      const w = noise() * 2 - 1;
      const d1 = w - p1;
      p1 = w;
      const d2 = d1 - p2;
      p2 = d1;
      return d2 * Math.exp(-t / tau) * vel * 0.22;
    });
  };
  const tone = (t0: number, len: number, f: number, vel: number, attack: number, decay: number, harmonics: number[]) => {
    const rel = Math.min(0.03, len / 4);
    add(t0, len, (_i, t) => {
      const env = Math.min(1, t / attack) * Math.min(1, (len - t) / rel) * (decay > 0 ? Math.exp(-t / decay) : 1);
      let s = 0;
      for (let h = 0; h < harmonics.length; h++) s += harmonics[h]! * Math.sin(2 * Math.PI * f * (h + 1) * t);
      return s * env * vel;
    });
  };

  const firstBar = -Math.ceil(spec.firstBeatSec / bar) - 1;
  const lastBar = Math.ceil((spec.durationSec - spec.firstBeatSec) / bar);
  const totalBars = lastBar;
  const breakdownAt = spec.breakdown ? Math.floor(totalBars / 2) : -1;
  for (let b = firstBar; b <= lastBar; b++) {
    const t0 = spec.firstBeatSec + b * bar;
    if (b < 0 && spec.intro !== "none") {
      // nothing before the first downbeat, except a pickup: a snare run into bar 0
      if (spec.intro === "pickup" && b === -1 && L.drums > 0) {
        for (let s = pat.steps - 4; s < pat.steps; s++) snare(t0 + s * stepSec, 0.5 + 0.1 * (s % 4) );
      }
      continue;
    }
    const chordRoot = key + prog[((b % 4) + 4) % 4]!;
    const padOnly = (spec.intro === "pad" && b < 4) || (b >= breakdownAt && b < breakdownAt + 4 && breakdownAt > 0);
    const fill = !padOnly && b % 8 === 7 && L.drums > 0;

    // pad: one soft-attack chord per bar
    for (const iv of [0, 7, 12, 15]) tone(t0, bar, hz(chordRoot + 12 + iv), 0.12 * L.pad, 0.08, 0, [1, 0.3]);
    // wandering "vocal": onsets on a random subset of eighths — rhythmically uninformative energy
    for (let e = 0; e < 8; e++) {
      if (rand() < 0.2) {
        const len = (1 + pick(4)) * (bar / 8);
        tone(t0 + e * (bar / 8) + jitter(), len, hz(chordRoot + 24 + [0, 3, 5, 7, 10][pick(5)]!), 0.3 * L.vocal, 0.03, 0, [1, 0.5, 0.25]);
      }
    }
    if (padOnly) continue;

    for (const [s, v] of pat.kick ?? []) kick(stepTime(t0, s), v * L.drums);
    for (const [s, v] of pat.snare ?? []) if (!(fill && s >= pat.steps - 4)) snare(stepTime(t0, s), v * L.drums);
    if (fill) for (let s = pat.steps - 4; s < pat.steps; s++) snare(t0 + s * stepSec + jitter(), (0.5 + 0.12 * (s % 4)) * L.drums);
    for (const [s, v] of pat.hat ?? []) hat(stepTime(t0, s), v * L.drums, false);
    for (const [s, v] of pat.ohat ?? []) hat(stepTime(t0, s), v * L.drums, true);
    for (const [s, v, len] of pat.bass ?? []) tone(stepTime(t0, s), (len ?? 2) * stepSec * 0.9, hz(chordRoot - 12), 0.6 * v * L.bass, 0.004, 0.4, [1, 0.4, 0.2]);
    for (const [s, v, len] of pat.stab ?? []) {
      const at = stepTime(t0, s);
      for (const iv of [0, 3, 7]) tone(at, Math.max(0.06, (len ?? 2) * stepSec * 0.9), hz(chordRoot + 12 + iv), 0.2 * v * L.stab, 0.003, 0.12, [1, 0.5, 0.33, 0.25]);
    }
  }

  // normalise to a sensible peak, then add the noise floor at the requested SNR
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(out[i]!));
    sq += out[i]! * out[i]!;
  }
  const g = peak > 0 ? 0.9 / peak : 1;
  const noiseAmp = Math.sqrt(sq / n) * g * 10 ** (-spec.snrDb / 20) * Math.sqrt(3);
  for (let i = 0; i < n; i++) out[i] = out[i]! * g + (noise() * 2 - 1) * noiseAmp;
  return out;
}

export function buildCorpus(perStyle: number, seed = 1, durationSec = 60): TrackSpec[] {
  const rand = mulberry32(seed);
  const specs: TrackSpec[] = [];
  for (const style of ALL_STYLES) {
    const [lo, hi] = STYLES[style](() => 0).bpmRange;
    for (let k = 0; k < perStyle; k++) {
      // stratified across the style's range, with fractional tempos (real songs are not integers)
      const bpm = Math.round((lo + ((k + rand()) / perStyle) * (hi - lo)) * 100) / 100;
      const beat = 60 / bpm;
      const intro = (["none", "silence", "pad", "pickup"] as const)[Math.floor(rand() * 4)]!;
      const firstBeatSec = intro === "none" ? rand() * beat : intro === "silence" || intro === "pickup" ? 0.3 + rand() * 3 : rand() * beat;
      specs.push({
        id: `${style}-${k}`,
        style,
        bpm,
        firstBeatSec: Math.round(firstBeatSec * 10000) / 10000,
        durationSec,
        sampleRate: 44100,
        snrDb: [40, 30, 20, 12][Math.floor(rand() * 4)]!,
        intro,
        jitterMs: [0, 0, 3, 8][Math.floor(rand() * 4)]!,
        breakdown: rand() < 0.3,
        seed: Math.floor(rand() * 2 ** 31),
      });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------------------

export type Verdict = "exact" | "octave" | "bad" | "triple" | "other" | "none";
const BAD_RATIOS: [string, number][] = [["4/3", 4 / 3], ["3/4", 3 / 4], ["2/3", 2 / 3], ["3/2", 3 / 2]];

export function classifyTempo(detected: number | null, truth: number): { verdict: Verdict; ratio: string } {
  if (detected === null) return { verdict: "none", ratio: "-" };
  if (Math.abs(detected - truth) <= 1.5) return { verdict: "exact", ratio: "1" };
  const near = (r: number) => Math.abs(detected / (r * truth) - 1) <= 0.02;
  if (near(2)) return { verdict: "octave", ratio: "2" };
  if (near(0.5)) return { verdict: "octave", ratio: "1/2" };
  for (const [name, r] of BAD_RATIOS) if (near(r)) return { verdict: "bad", ratio: name };
  if (near(3)) return { verdict: "triple", ratio: "3" };
  if (near(1 / 3)) return { verdict: "triple", ratio: "1/3" };
  return { verdict: "other", ratio: (detected / truth).toFixed(3) };
}

const wrapSigned = (x: number, period: number): number => {
  const w = ((x % period) + period) % period;
  return w >= period / 2 ? w - period : w;
};

/**
 * Signed distance (seconds, + = the detected grid is late) between the detected grid and the true
 * beats around time `atSec`. With an octave error the finer grid is compared against the coarser
 * one, so "every other switch lands on a beat" counts as zero error.
 */
export function gridErrorSec(det: { bpm: number; beatOffsetSec: number }, truth: { bpm: number; firstBeatSec: number }, atSec: number): number {
  const pd = 60 / det.bpm;
  const pt = 60 / truth.bpm;
  if (pd <= pt) {
    const beatTime = truth.firstBeatSec + Math.round((atSec - truth.firstBeatSec) / pt) * pt;
    return -wrapSigned(beatTime - det.beatOffsetSec, pd);
  }
  const gridTime = det.beatOffsetSec + Math.round((atSec - det.beatOffsetSec) / pd) * pd;
  return wrapSigned(gridTime - truth.firstBeatSec, pt);
}

export interface TrackScore {
  spec: TrackSpec;
  detected: { bpm: number; beatOffsetSec: number } | null;
  verdict: Verdict;
  ratio: string;
  /** Present when the tempo is exact or octave-related. */
  offsetErrMs?: number;
  /** Grid error 240 s in: the offset error plus what the tempo error has accumulated. */
  errAt240Ms?: number;
  ms: number;
}

export type Detector = (samples: Float32Array, sampleRate: number) => { bpm: number; beatOffsetSec: number } | null;

export function scoreTrack(spec: TrackSpec, detector: Detector, samples = renderTrack(spec)): TrackScore {
  const t0 = performance.now();
  const detected = detector(samples, spec.sampleRate);
  const ms = performance.now() - t0;
  const { verdict, ratio } = classifyTempo(detected?.bpm ?? null, spec.bpm);
  const score: TrackScore = { spec, detected, verdict, ratio, ms };
  if (detected && (verdict === "exact" || verdict === "octave")) {
    score.offsetErrMs = gridErrorSec(detected, spec, 0) * 1000;
    score.errAt240Ms = gridErrorSec(detected, spec, 240) * 1000;
  }
  return score;
}

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export interface Summary {
  n: number;
  exact: number;
  octave: number;
  bad: number;
  other: number;
  /** Tempo acceptable AND the grid within 30 ms of the beats at t=0. */
  onBeat: number;
  /** …and still within 30 ms four minutes in. */
  onBeatAt240: number;
  offsetBiasMs: number;
  offsetP50Ms: number;
  offsetP90Ms: number;
  at240P50Ms: number;
  at240P90Ms: number;
}

export function summarize(scores: TrackScore[]): Summary {
  const n = scores.length;
  const count = (f: (s: TrackScore) => boolean) => scores.filter(f).length;
  const offs = scores.filter((s) => s.offsetErrMs !== undefined).map((s) => s.offsetErrMs!);
  const at240 = scores.filter((s) => s.errAt240Ms !== undefined).map((s) => Math.abs(s.errAt240Ms!));
  return {
    n,
    exact: count((s) => s.verdict === "exact"),
    octave: count((s) => s.verdict === "octave"),
    bad: count((s) => s.verdict === "bad"),
    other: count((s) => s.verdict === "other" || s.verdict === "triple" || s.verdict === "none"),
    onBeat: count((s) => s.offsetErrMs !== undefined && Math.abs(s.offsetErrMs) <= 30),
    onBeatAt240: count((s) => s.errAt240Ms !== undefined && Math.abs(s.offsetErrMs!) <= 30 && Math.abs(s.errAt240Ms) <= 30),
    offsetBiasMs: quantile(offs, 0.5),
    offsetP50Ms: quantile(offs.map(Math.abs), 0.5),
    offsetP90Ms: quantile(offs.map(Math.abs), 0.9),
    at240P50Ms: quantile(at240, 0.5),
    at240P90Ms: quantile(at240, 0.9),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--detector", "--seed", "--per-style", "--seconds", "--only"].includes(argv[i - 1]!)));

  let detector: Detector = currentDetector;
  let label = `src/upload/bpm.ts v${BPM_ALGORITHM_VERSION}`;
  const alt = opt("detector");
  if (alt) {
    const mod = await import(alt.match(/^([a-zA-Z]:|\/)/) ? `file://${alt.replace(/\\/g, "/")}` : `${process.cwd()}/${alt}`);
    detector = mod.detectBeatGrid;
    label = `${alt} v${mod.BPM_ALGORITHM_VERSION ?? "?"}`;
  }
  const pct = (k: number, n: number) => `${((100 * k) / Math.max(1, n)).toFixed(0)}%`.padStart(4);
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-").padStart(6);

  if (!flag("no-corpus")) {
    const perStyle = Number(opt("per-style") ?? (flag("quick") ? 4 : 14));
    const only = opt("only");
    const corpus = buildCorpus(perStyle, Number(opt("seed") ?? 1), Number(opt("seconds") ?? 60)).filter((s) => !only || s.style === only);
    console.log(`\n== ${label} — synthetic corpus: ${corpus.length} tracks (${perStyle}/style, ${corpus[0]?.durationSec}s each) ==`);
    const scores: TrackScore[] = [];
    for (const spec of corpus) scores.push(scoreTrack(spec, detector));

    const header = `${"style".padEnd(15)}   n exact  oct  BAD other | on-beat @240s | offset ms: bias   p50   p90 | @240s ms: p50    p90`;
    console.log(header);
    const row = (name: string, s: Summary) =>
      `${name.padEnd(15)} ${String(s.n).padStart(3)}  ${pct(s.exact, s.n)} ${pct(s.octave, s.n)} ${pct(s.bad, s.n)}  ${pct(s.other, s.n)} |    ${pct(s.onBeat, s.n)}  ${pct(s.onBeatAt240, s.n)} |           ${f1(s.offsetBiasMs)}${f1(s.offsetP50Ms)}${f1(s.offsetP90Ms)} |        ${f1(s.at240P50Ms)} ${f1(s.at240P90Ms)}`;
    for (const style of ALL_STYLES) {
      const group = scores.filter((s) => s.spec.style === style);
      if (group.length) console.log(row(style, summarize(group)));
    }
    const all = summarize(scores);
    console.log("-".repeat(header.length));
    console.log(row("ALL", all));
    const acc = all.exact + all.octave;
    console.log(
      `\ntempo acceptable (exact or octave): ${acc}/${all.n}   bad ratio (4/3, 3/4, 2/3, 3/2): ${all.bad}/${all.n}   other: ${all.other}/${all.n}` +
        `\nstrobe on the beat (tempo ok and |offset| <= 30 ms) at t=0: ${all.onBeat}/${all.n}   still on the beat at 240 s: ${all.onBeatAt240}/${all.n}` +
        `\nmean detect time ${(scores.reduce((a, s) => a + s.ms, 0) / scores.length).toFixed(0)} ms per ${corpus[0]?.durationSec}s track`,
    );
    if (flag("failures") || flag("verbose")) {
      console.log("\nfailures:");
      for (const s of scores) {
        const tempoOk = s.verdict === "exact" || s.verdict === "octave";
        if (tempoOk && Math.abs(s.offsetErrMs!) <= 30 && !flag("verbose")) continue;
        console.log(
          `  ${s.spec.id.padEnd(18)} truth ${s.spec.bpm.toFixed(2).padStart(7)} first ${s.spec.firstBeatSec.toFixed(3)} ${s.spec.intro.padEnd(7)} snr ${s.spec.snrDb} jit ${s.spec.jitterMs}` +
            ` -> ${s.detected ? `${s.detected.bpm} @ ${s.detected.beatOffsetSec}` : "null"}  [${s.verdict} x${s.ratio}]${tempoOk ? ` offset ${s.offsetErrMs!.toFixed(1)} ms, @240s ${s.errAt240Ms!.toFixed(1)} ms` : ""}`,
        );
      }
    }
  }

  if (flag("perf")) {
    const spec: TrackSpec = { id: "perf", style: "backbeat", bpm: 123.45, firstBeatSec: 0.731, durationSec: 240, sampleRate: 44100, snrDb: 30, intro: "none", jitterMs: 0, breakdown: true, seed: 7 };
    const samples = renderTrack(spec);
    Bun.gc(true);
    const before = process.memoryUsage();
    let peakRss = before.rss;
    const times: number[] = [];
    let last: TrackScore | null = null;
    for (let i = 0; i < 5; i++) {
      last = scoreTrack(spec, detector, samples);
      times.push(last.ms);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    console.log(
      `\n== perf (${label}): 240 s mono 44.1 kHz ==\n  detect time: first ${times[0]!.toFixed(0)} ms, best ${Math.min(...times).toFixed(0)} ms\n` +
        `  RSS before ${(before.rss / 1e6).toFixed(0)} MB (input alone is ${(samples.byteLength / 1e6).toFixed(0)} MB), peak during ${(peakRss / 1e6).toFixed(0)} MB (+${((peakRss - before.rss) / 1e6).toFixed(0)} MB)\n` +
        `  result: ${JSON.stringify(last!.detected)} truth ${spec.bpm} @ ${spec.firstBeatSec} -> ${last!.verdict}, offset ${last!.offsetErrMs?.toFixed(1)} ms, @240s ${last!.errAt240Ms?.toFixed(1)} ms`,
    );
  }

  // Held-out real files: `path.wav` or `path.wav:<true bpm>`. Read-only; nothing is written.
  for (const arg of files) {
    const m = arg.match(/^(.*\.wav)(?::([\d.]+))?$/i);
    if (!m) continue;
    const wav = parseWav(new Uint8Array(await Bun.file(m[1]!).arrayBuffer()));
    const mono = wav.channels[0]!;
    const t0 = performance.now();
    const grid = detector(mono, wav.sampleRate);
    const ms = performance.now() - t0;
    const truth = m[2] ? Number(m[2]) : null;
    const verdict = truth ? classifyTempo(grid?.bpm ?? null, truth) : null;
    console.log(
      `\n${m[1]}\n  ${wav.durationSec.toFixed(1)} s @ ${wav.sampleRate} Hz -> ${grid ? `${grid.bpm} BPM, beat offset ${grid.beatOffsetSec} s` : "null"} in ${ms.toFixed(0)} ms` +
        (verdict ? `   truth ${truth}: ${verdict.verdict.toUpperCase()} (x${verdict.ratio})` : ""),
    );
  }
}
