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
export const BPM_ALGORITHM_VERSION = 2;

export function detectBpm(samples: Float32Array, sampleRate: number): number | null {
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
  return Math.round(bpm * 10) / 10;
}
