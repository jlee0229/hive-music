/**
 * Tempo + beat-grid detection for uploaded tracks (pure TS, no ffmpeg, no dependencies — same
 * constraint as the rest of the upload pipeline).
 *
 * v4. What the strobe needs is not "a tempo that correlates" but a single grid (period, phase) that
 * stays on the drum hits for the whole song. v1–v3 picked the best autocorrelation lag of one
 * broadband envelope, and autocorrelation counts *pairs* of onsets: a 3-3-2 / dotted-eighth figure
 * puts more pairs 0.75 beats apart than 1 beat apart, so syncopated songs came out at exactly 4/3
 * (or 2/3) of their tempo — a grid that walks through the bar. And one lag step is ~3 BPM, so even
 * a "right" answer was 0.1–0.5 BPM off: the grid slid 100–300 ms off the beat within a few minutes.
 *
 *  1. Onsets per frequency band (STFT log-spectral flux → 4 bands). Kicks, snares and hats no
 *     longer mask each other, and a hat can never be mistaken for a kick 3/4 of a beat later.
 *  2. Each candidate period is scored by FOLDING every band's onsets onto that period and asking
 *     how much lands on one phase (per band, in 12 s windows). A grid at 4/3 of the tempo only
 *     lines up with the pattern once every three beats, so it scores a third of what the true
 *     grid does, however many pairs it has. A wide log-normal prior only settles the octave.
 *  3. The winner is refined against the whole track (the period that keeps the fold sharpest from
 *     the first bar to the last), which pins the tempo to ~0.002 BPM, and the phase is read off
 *     that fold with the low band (the kick) weighted up so the grid sits on the beat, not the
 *     off-beat hats.
 *
 * A track where nothing folds better than noise would (speech, ambience, free time) returns null,
 * and the strobe falls back to its free-running period — exactly like before tempo sync existed.
 *
 * Measured with `bun apps/server/scripts/bpm-eval.ts` (210 synthetic tracks + held-out real files);
 * re-run it before changing any constant here.
 */

const MIN_BPM = 60;
const MAX_BPM = 200;
/** Prior center/width (octaves): only decides between a tempo and its double/half. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 1.3;
/** Tempo is chosen on at most this much audio; the refinement and the phase use the whole track. */
const MAX_SELECT_SEC = 120;
/** Whole-track refinement is bounded too (10-minute uploads are allowed). */
const MAX_REFINE_SEC = 360;

/** STFT geometry at the decimated rate (~22 kHz): 11.6 ms windows every 5.8 ms. */
const FFT_SIZE = 256;
const FFT_HOP = 128;
const TARGET_RATE = 22050;
/** Sub-band edges in FFT bins (upper-exclusive), grouped into the four onset bands below. */
const SUB_EDGES = [0, 2, 3, 4, 6, 9, 13, 19, 27, 38, 54, 76, 129];
/** Which onset band each sub-band feeds: 0 = low (kick/bass), 1 = low-mid, 2 = mid, 3 = high. */
const SUB_TO_BAND = [0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3];
const BANDS = 4;
/** Coherence window for tempo selection, seconds. */
const SELECT_WINDOW_SEC = 12;
/**
 * A fold peak is a maximum over ~P bins of means of ~W/P frames, so even noise produces one, and a
 * bigger one for longer periods. This many expected-noise-maxima are subtracted from every peak;
 * without it the slow impostors (2/3 of the tempo) get a head start that only the prior hides.
 */
const NOISE_PEAK_FACTOR = 1.5;
/** How much the kick band counts when choosing which phase of the period is "the beat". */
const LOW_BAND_PHASE_WEIGHT = 3;
/** Measured on the eval corpus (scripts/bpm-eval.ts): the fold peak trails the attack by ~3 ms. */
const ONSET_LATENCY_SEC = 0.003;

/** Bump to force the startup backfill to re-analyze every track with the current algorithm. */
export const BPM_ALGORITHM_VERSION = 4;

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

/** In-place radix-2 FFT, tables shared across calls. */
const COS = new Float64Array(FFT_SIZE / 2);
const SIN = new Float64Array(FFT_SIZE / 2);
const REV = new Uint16Array(FFT_SIZE);
const HANN = new Float64Array(FFT_SIZE);
{
  const bits = Math.log2(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    COS[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
    SIN[i] = Math.sin((2 * Math.PI * i) / FFT_SIZE);
  }
  for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    REV[i] = r;
    HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  }
}
function fft(re: Float64Array, im: Float64Array): void {
  const n = FFT_SIZE;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k;
        const b = a + half;
        const c = COS[t]!;
        const s = SIN[t]!;
        const xr = re[b]! * c + im[b]! * s;
        const xi = im[b]! * c - re[b]! * s;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

interface Onsets {
  /** One onset-strength curve per band, each scaled to unit mean (an all-zero band stays zero). */
  bands: Float32Array[];
  frames: number;
  /** Frames per second. */
  frameRate: number;
}

/** Per-band log-spectral flux. `maxSec` bounds the work for very long uploads. */
function onsetBands(samples: Float32Array, sampleRate: number, maxSec: number): Onsets | null {
  const decim = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / decim;
  const usable = Math.floor(Math.min(samples.length, sampleRate * maxSec) / decim);
  const frames = Math.floor((usable - FFT_SIZE) / FFT_HOP) + 1;
  const frameRate = rate / FFT_HOP;
  if (frames < frameRate * 10) return null; // under ~10 s of audio: not enough beats to trust

  const subs = SUB_TO_BAND.length;
  const logPow = new Float32Array(frames * subs);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * FFT_HOP * decim;
    for (let i = 0; i < FFT_SIZE; i++) {
      let s = 0;
      const at = base + i * decim;
      for (let d = 0; d < decim; d++) s += samples[at + d]!;
      re[REV[i]!] = (s / decim) * HANN[i]!;
    }
    im.fill(0);
    fft(re, im);
    for (let b = 0; b < subs; b++) {
      let p = 0;
      for (let k = SUB_EDGES[b]!; k < SUB_EDGES[b + 1]!; k++) p += re[k]! * re[k]! + im[k]! * im[k]!;
      logPow[f * subs + b] = p;
      total += p;
    }
  }
  if (!(total > 0)) return null; // silence

  // Log compression with a floor 50 dB under the track's mean sub-band power: quiet-verse onsets
  // count, but digital silence → noise floor is not an "onset".
  const floor = (total / (frames * subs)) * 1e-5;
  for (let i = 0; i < logPow.length; i++) logPow[i] = Math.log(logPow[i]! + floor);

  const bands = Array.from({ length: BANDS }, () => new Float32Array(frames));
  // Flux against the frame two hops back: adjacent frames overlap by half, so a one-hop difference
  // would split every attack across two frames.
  for (let f = 2; f < frames; f++) {
    for (let b = 0; b < subs; b++) {
      const d = logPow[f * subs + b]! - logPow[(f - 2) * subs + b]!;
      if (d > 0) {
        const band = bands[SUB_TO_BAND[b]!]!;
        band[f] = band[f]! + d;
      }
    }
  }
  for (const band of bands) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += band[f]!;
    if (sum > 0) {
      const scale = frames / sum;
      for (let f = 0; f < frames; f++) band[f] = band[f]! * scale;
    }
  }
  return { bands, frames, frameRate };
}

/** Halves the frame rate (pair sums) and smooths with [1 2 1]/4: the tempo scan does not need 6 ms bins. */
function coarsen(band: Float32Array, frames: number): Float32Array {
  const n = frames >> 1;
  const half = new Float32Array(n);
  for (let i = 0; i < n; i++) half[i] = 0.5 * (band[2 * i]! + band[2 * i + 1]!);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.25 * (half[i - 1] ?? 0) + 0.5 * half[i]! + 0.25 * (half[i + 1] ?? 0);
  return out;
}

/**
 * Folds `osf[from, to)` (with `stride` interleaved curves per frame) onto `period` (frames,
 * fractional) and returns, per curve, the largest per-bin MEAN. Bins are ~one frame wide; a bin's
 * mean is taken over the frames that actually fell in it, because with a fractional period the bins
 * are not evenly filled (at period 32.999 one bin in 32 receives two frames per turn — summing
 * instead of averaging makes every near-integer period look twice as rhythmic as it is).
 */
function foldPeaks(osf: Float32Array, stride: number, from: number, to: number, period: number, fold: Float32Array, counts: Float32Array, out: Float64Array): void {
  const bins = Math.floor(period);
  const scale = bins / period;
  fold.fill(0, 0, (bins + 1) * stride);
  counts.fill(0, 0, bins + 1);
  let phase = from % period;
  if (stride === 4) {
    for (let f = from, o = from * 4; f < to; f++, o += 4) {
      const i = (phase * scale) | 0;
      const j = i * 4;
      fold[j] = fold[j]! + osf[o]!;
      fold[j + 1] = fold[j + 1]! + osf[o + 1]!;
      fold[j + 2] = fold[j + 2]! + osf[o + 2]!;
      fold[j + 3] = fold[j + 3]! + osf[o + 3]!;
      counts[i] = counts[i]! + 1;
      phase += 1;
      if (phase >= period) phase -= period;
    }
  } else {
    for (let f = from; f < to; f++) {
      const i = (phase * scale) | 0;
      fold[i] = fold[i]! + osf[f]!;
      counts[i] = counts[i]! + 1;
      phase += 1;
      if (phase >= period) phase -= period;
    }
  }
  // float spill at the wrap lands in bin `bins`; it belongs to the last real bin
  counts[bins - 1] = counts[bins - 1]! + counts[bins]!;
  for (let c = 0; c < stride; c++) {
    fold[(bins - 1) * stride + c] = fold[(bins - 1) * stride + c]! + fold[bins * stride + c]!;
    let best = 0;
    for (let i = 0; i < bins; i++) {
      const n = counts[i]!;
      if (n > 0) {
        const m = fold[i * stride + c]! / n;
        if (m > best) best = m;
      }
    }
    out[c] = best;
  }
}

export function detectBeatGrid(samples: Float32Array, sampleRate: number): BeatGrid | null {
  const onsets = onsetBands(samples, sampleRate, MAX_REFINE_SEC);
  if (!onsets) return null;
  const { bands, frames, frameRate } = onsets;

  // ---- 1 · choose the tempo: fold every band onto every candidate period ----------------------
  const cRate = frameRate / 2;
  const cFrames = Math.min(frames >> 1, Math.floor(MAX_SELECT_SEC * cRate));
  const coarse = bands.map((b) => coarsen(b, frames));
  const win = Math.min(cFrames, Math.round(SELECT_WINDOW_SEC * cRate));
  const windows: number[] = [];
  for (let s = 0; s + win <= cFrames; s += win) windows.push(s);
  // Per-window mean and spread of each band: the fold peak is measured above them, so a window
  // with nothing going on (an intro, a breakdown) contributes nothing instead of noise.
  const means = coarse.map((c) =>
    windows.map((s) => {
      let sum = 0;
      for (let f = s; f < s + win; f++) sum += c[f]!;
      return sum / win;
    }),
  );
  const sigmas = coarse.map((c, b) =>
    windows.map((s, w) => {
      let sq = 0;
      const m = means[b]![w]!;
      for (let f = s; f < s + win; f++) sq += (c[f]! - m) ** 2;
      return Math.sqrt(sq / win);
    }),
  );
  const minP = (60 / MAX_BPM) * cRate;
  const maxP = (60 / MIN_BPM) * cRate;
  // Candidates are spaced so the grid slips at most ~one bin across a window between neighbours.
  const ratio = 1 + 1 / win;
  const osf4 = new Float32Array(cFrames * BANDS);
  for (let b = 0; b < BANDS; b++) for (let f = 0; f < cFrames; f++) osf4[f * BANDS + b] = coarse[b]![f]!;
  const fold = new Float32Array((Math.ceil(maxP) + 2) * BANDS);
  const counts = new Float32Array(Math.ceil(maxP) + 2);
  const peak4 = new Float64Array(BANDS);
  let bestP = 0;
  let bestScore = -Infinity;
  for (let p = minP; p <= maxP; p *= ratio) {
    const noise = NOISE_PEAK_FACTOR * Math.sqrt((2 * Math.log(Math.floor(p)) * p) / win);
    let g = 0;
    for (let w = 0; w < windows.length; w++) {
      foldPeaks(osf4, BANDS, windows[w]!, windows[w]! + win, p, fold, counts, peak4);
      for (let b = 0; b < BANDS; b++) {
        const m = means[b]![w]!;
        if (m > 0) g += peak4[b]! - m - noise * sigmas[b]![w]!;
      }
    }
    const bpm = (60 * cRate) / p;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES) ** 2);
    const score = g * prior;
    if (score > bestScore) {
      bestScore = score;
      bestP = p;
    }
  }
  // Nothing folds better than noise would: no usable beat (speech, ambience, rubato).
  if (bestP === 0 || !(bestScore > 0)) return null;

  // ---- 2 · refine against the whole track at full frame resolution ----------------------------
  // One curve for the grid: every band, with the kick band weighted up (it defines "the beat").
  const grid = new Float32Array(frames);
  for (let b = 0; b < BANDS; b++) {
    const w = b === 0 ? LOW_BAND_PHASE_WEIGHT : 1;
    const band = bands[b]!;
    for (let f = 0; f < frames; f++) grid[f] = grid[f]! + w * band[f]!;
  }
  // light smoothing so a fold bin and its neighbours cooperate
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) smooth[f] = 0.25 * (grid[f - 1] ?? 0) + 0.5 * grid[f]! + 0.25 * (grid[f + 1] ?? 0);

  const p0 = bestP * 2; // period in full-rate frames
  const fineFold = new Float32Array(Math.ceil(p0 * (1 + 2 / win)) + 4);
  const fineCounts = new Float32Array(fineFold.length);
  const one = new Float64Array(1);
  // The coarse step was 1/win; search ±1.5 of those in steps that slip half a frame over the track.
  const span = 1.5 / win;
  const step = 0.5 / frames;
  let refined = p0;
  let refinedPeak = -Infinity;
  const peaks: number[] = [];
  const steps = Math.ceil(span / step);
  for (let k = -steps; k <= steps; k++) {
    const p = p0 * (1 + k * step);
    foldPeaks(smooth, 1, 0, frames, p, fineFold, fineCounts, one);
    const peak = one[0]!;
    peaks.push(peak);
    if (peak > refinedPeak) {
      refinedPeak = peak;
      refined = p;
    }
  }
  {
    // parabolic interpolation across the three best steps
    const i = peaks.indexOf(refinedPeak);
    if (i > 0 && i < peaks.length - 1) {
      const d = peaks[i - 1]! - 2 * peaks[i]! + peaks[i + 1]!;
      if (d < 0) refined = p0 * (1 + (i - steps + Math.max(-0.5, Math.min(0.5, (0.5 * (peaks[i - 1]! - peaks[i + 1]!)) / d))) * step);
    }
  }
  const bpm = (60 * frameRate) / refined;
  if (!Number.isFinite(bpm) || bpm < MIN_BPM * 0.98 || bpm > MAX_BPM * 1.02) return null;

  // ---- 3 · phase: where on that period the onsets pile up ------------------------------------
  const bins = Math.floor(refined);
  const scale = bins / refined;
  const ph = new Float32Array(bins + 1);
  const phN = new Float32Array(bins + 1);
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const i = (phase * scale) | 0;
    ph[i] = ph[i]! + smooth[f]!;
    phN[i] = phN[i]! + 1;
    phase += 1;
    if (phase >= refined) phase -= refined;
  }
  ph[bins - 1] = ph[bins - 1]! + ph[bins]!;
  phN[bins - 1] = phN[bins - 1]! + phN[bins]!;
  for (let i = 0; i < bins; i++) ph[i] = phN[i]! > 0 ? ph[i]! / phN[i]! : 0;
  let bestBin = 0;
  for (let i = 1; i < bins; i++) if (ph[i]! > ph[bestBin]!) bestBin = i;
  const a = ph[(bestBin - 1 + bins) % bins]!;
  const c = ph[(bestBin + 1) % bins]!;
  const d = a - 2 * ph[bestBin]! + c;
  const sub = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
  // bin i holds phases [i, i+1)/scale frames; its centre is the estimate. A frame's time is its
  // window centre.
  const beatSec = 60 / bpm;
  const phaseFrames = (bestBin + 0.5 + sub) / scale;
  let beatOffsetSec = (phaseFrames / frameRate + FFT_SIZE / 2 / (frameRate * FFT_HOP) - ONSET_LATENCY_SEC) % beatSec;
  if (beatOffsetSec < 0) beatOffsetSec += beatSec;

  return { bpm: Math.round(bpm * 1000) / 1000, beatOffsetSec: Math.round(beatOffsetSec * 10000) / 10000 };
}
