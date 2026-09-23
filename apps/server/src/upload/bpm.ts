/**
 * Tempo detection for uploaded tracks (pure TS, no ffmpeg — same constraint as the rest of the
 * upload pipeline).
 *
 * v2: the v1 single-peak autocorrelation locked onto mathematically related tempos (2/3x, 4/3x,
 * half) on songs with swung or half-time feels. This version scores every candidate the way real
 * tempo estimators do (Ellis 2007):
 *  - onset strength = half-wave-rectified log-energy flux (log makes quiet-verse onsets count),
 *  - each candidate lag's score adds its harmonics — corr at half the lag (double tempo) and
 *    twice the lag (half tempo) reinforce the true beat, because real songs have both,
 *  - a log-Gaussian prior centered on 120 BPM breaks octave ties toward the tempo people tap.
 *
 * A track with no rhythmic content returns whatever correlates best; the strobe treats that the
 * same as any tempo — worst case it flashes steadily, exactly like before tempo sync existed.
 */

const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;
/** Prior center/width (octaves): what a human taps when the octave is ambiguous. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 0.8;
/** Analyze at most this much audio: plenty for a stable tempo estimate, bounded CPU per upload. */
const MAX_ANALYSIS_SEC = 120;

/** Bump to force the startup backfill to re-analyze every track with the current algorithm. */
export const BPM_ALGORITHM_VERSION = 3;

export interface BeatGrid {
  bpm: number;
  /**
   * Where the beat grid sits relative to track time 0, seconds in [0, beat): songs open with
   * intros and pickups, so beat 1 is almost never at 0:00. The strobe anchors its switches here —
   * on the drum hits, not somewhere between them.
   */
  beatOffsetSec: number;
}

/** Back-compat convenience (tests, quick checks): just the tempo. */
export function detectBpm(samples: Float32Array, sampleRate: number): number | null {
  return detectBeatGrid(samples, sampleRate)?.bpm ?? null;
}

export function detectBeatGrid(samples: Float32Array, sampleRate: number): BeatGrid | null {
  const usable = Math.min(samples.length, sampleRate * MAX_ANALYSIS_SEC);
  const frames = Math.floor(usable / HOP);
  const frameRate = sampleRate / HOP;
  if (frames < frameRate * 10) return null; // under ~10s of audio: not enough beats to trust

  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const off = f * HOP;
    for (let i = 0; i < HOP; i++) {
      const s = samples[off + i]!;
      acc += s * s;
    }
    env[f] = Math.sqrt(acc / HOP);
  }
  const EPS = 1e-6;
  const flux = new Float32Array(frames);
  let fluxSum = 0;
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, Math.log(env[f]! + EPS) - Math.log(env[f - 1]! + EPS));
    fluxSum += flux[f]!;
  }
  if (fluxSum === 0) return null; // silence

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * frameRate));
  const maxLag = Math.min(frames - 1, Math.ceil((60 / MIN_BPM) * frameRate));
  // Raw autocorrelation out to 2·maxLag so half-tempo harmonics are available to every candidate.
  const corrMax = Math.min(frames - 1, maxLag * 2);
  const corr = new Float32Array(corrMax + 1);
  for (let lag = Math.floor(minLag / 2); lag <= corrMax; lag++) {
    let acc = 0;
    for (let f = lag; f < frames; f++) acc += flux[f]! * flux[f - lag]!;
    corr[lag] = acc / (frames - lag);
  }
  const at = (lag: number): number => {
    const lo = Math.floor(lag);
    const t = lag - lo;
    return (corr[lo] ?? 0) * (1 - t) + (corr[lo + 1] ?? 0) * t;
  };

  let bestLag = 0;
  let bestScore = -Infinity;
  const scoreOf = (lag: number): number => {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES) ** 2);
    // The beat, its double-time subdivision, and its half-time grouping all reinforce a true tempo.
    return prior * (at(lag) + 0.5 * at(lag / 2) + 0.5 * at(lag * 2));
  };
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = scoreOf(lag);
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return null;

  // Parabolic refinement on the combined score: one lag step is ~3 BPM at 120.
  const y0 = scoreOf(bestLag - 1);
  const y1 = scoreOf(bestLag);
  const y2 = scoreOf(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const lag = bestLag + offset;

  const bpm = (60 * frameRate) / lag;
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;

  // Beat phase: fold the onset envelope by the beat period and find the phase where the onsets
  // pile up — that is where the drums actually hit. Circular parabolic refinement takes the
  // estimate below one envelope frame (~12 ms), well inside the strobe's 10 ms ramp.
  const periodFrames = lag;
  const bins = Math.max(1, Math.floor(periodFrames));
  const fold = new Float32Array(bins);
  for (let f = 1; f < frames; f++) {
    const phase = Math.floor(f % periodFrames);
    if (phase < bins) fold[phase] = fold[phase]! + flux[f]!;
  }
  let bestBin = 0;
  for (let i = 1; i < bins; i++) if (fold[i]! > fold[bestBin]!) bestBin = i;
  const p0 = fold[(bestBin - 1 + bins) % bins]!;
  const p1 = fold[bestBin]!;
  const p2 = fold[(bestBin + 1) % bins]!;
  const pd = p0 - 2 * p1 + p2;
  const binOffset = pd !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (p0 - p2)) / pd)) : 0;
  const beatSec = 60 / bpm;
  // The fold anchors phase to frame 0; onset flux marks a beat one frame after the energy rises,
  // so pull half a hop back toward the true attack.
  let beatOffsetSec = (((bestBin + binOffset) * HOP) / sampleRate - HOP / (2 * sampleRate)) % beatSec;
  if (beatOffsetSec < 0) beatOffsetSec += beatSec;

  return { bpm: Math.round(bpm * 10) / 10, beatOffsetSec: Math.round(beatOffsetSec * 10000) / 10000 };
}
