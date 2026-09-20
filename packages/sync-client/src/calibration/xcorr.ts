/**
 * The matched filter behind Tier-2 calibration, and behind the measurement rig. Pure TypeScript on
 * `Float32Array`, no DOM, no FFT — so the app, the rig and the tests all run the identical code
 * (docs/04-calibration.md).
 *
 * Why plain time-domain correlation is enough: a ±150 ms window at 48 kHz is 14 400 lags and the template
 * is ~1 056 samples (22 ms), so a click costs ~15 M multiply-adds — a few milliseconds in JavaScript, run
 * once after the recording ends rather than live. An FFT would be faster and would add a dependency, a
 * padding convention and a class of off-by-one errors to a measurement whose whole job is to be right.
 *
 * Why the relative answer is the only one we need: every click reaches the reference through the same
 * microphone, the same input latency, the same worklet buffering and the same recording clock. Those add
 * one unknown constant to every arrival, and subtracting the group median removes it exactly. The host's
 * own clock offset and input latency therefore never enter the result — only the ±150 ms window placement
 * uses the host's clock, where a 5 ms error is irrelevant.
 */

/** Normalises a copy of the template to unit energy, so peaks are comparable across players. */
export function normalizeEnergy(input: Float32Array): Float32Array {
  let energy = 0;
  for (const v of input) energy += v * v;
  const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! * scale;
  return out;
}

export interface PeakResult {
  /** Best lag, in samples, as a (possibly fractional) index into the recording. */
  lagSamples: number;
  /** Normalised correlation at the peak, 0..1 for a real match. */
  peak: number;
  /** Best correlation outside ±`guardMs` of the peak — what makes the peak believable or not. */
  secondPeak: number;
  /** `clamp(1 − secondPeak / peak, 0, 1)` (docs/04). 1 = unambiguous, 0 = indistinguishable from noise. */
  confidence: number;
  /** Prominence against the whole window: peak / (mean|xc| + 3σ), clamped to 1. Diagnostic only. */
  prominence: number;
}

export interface PeakOptions {
  /** First lag to test, in samples. Clamped to the recording. */
  fromSample: number;
  /** Last lag to test, exclusive. */
  toSample: number;
  /** Half-width of the exclusion zone around the peak when looking for a competitor, ms. */
  guardMs?: number;
  sampleRate: number;
}

/**
 * Normalised cross-correlation of `template` against `recording` over a lag range, plus the diagnostics
 * that say whether the winner means anything.
 *
 * The denominator is the local energy of the recording under the template, recomputed per lag from a
 * prefix sum. Without it a loud phone out-votes a quiet one and "confidence" measures volume.
 */
export function findPeak(recording: Float32Array, template: Float32Array, opts: PeakOptions): PeakResult {
  const m = template.length;
  const n = recording.length;
  const from = Math.max(0, Math.floor(opts.fromSample));
  const to = Math.min(n - m, Math.ceil(opts.toSample));
  if (m === 0 || to <= from) {
    return { lagSamples: from, peak: 0, secondPeak: 0, confidence: 0, prominence: 0 };
  }

  // prefix sums of squares → local energy for any window in O(1)
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + recording[i]! * recording[i]!;

  const xc = new Float64Array(to - from);
  for (let lag = from; lag < to; lag++) {
    let num = 0;
    for (let i = 0; i < m; i++) num += recording[lag + i]! * template[i]!;
    const energy = prefix[lag + m]! - prefix[lag]!;
    xc[lag - from] = energy > 0 ? num / Math.sqrt(energy) : 0;
  }

  let bestIdx = 0;
  let best = -Infinity;
  for (let i = 0; i < xc.length; i++) {
    if (xc[i]! > best) {
      best = xc[i]!;
      bestIdx = i;
    }
  }

  // Sub-sample refinement: the speaker and microphone smear the burst, so the true arrival usually sits
  // between two samples. A parabola through the peak and its neighbours recovers most of that.
  let refined = bestIdx;
  if (bestIdx > 0 && bestIdx < xc.length - 1) {
    const y0 = xc[bestIdx - 1]!;
    const y1 = xc[bestIdx]!;
    const y2 = xc[bestIdx + 1]!;
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = (0.5 * (y0 - y2)) / denom;
      if (Math.abs(delta) <= 1) refined = bestIdx + delta;
    }
  }

  const guardSamples = Math.max(1, Math.round((((opts.guardMs ?? 2) / 1000) * opts.sampleRate)));
  let second = 0;
  let sumAbs = 0;
  let sumSq = 0;
  for (let i = 0; i < xc.length; i++) {
    const v = xc[i]!;
    sumAbs += Math.abs(v);
    sumSq += v * v;
    if (Math.abs(i - bestIdx) > guardSamples && v > second) second = v;
  }
  const mean = sumAbs / xc.length;
  const sd = Math.sqrt(Math.max(0, sumSq / xc.length - mean * mean));
  const confidence = best > 0 ? Math.min(1, Math.max(0, 1 - second / best)) : 0;
  const prominence = mean + 3 * sd > 0 ? Math.min(1, Math.max(0, best / (mean + 3 * sd))) : 0;

  return { lagSamples: from + refined, peak: Math.max(0, best), secondPeak: Math.max(0, second), confidence, prominence };
}

export interface MultiPeak {
  lagSamples: number;
  value: number;
}

/**
 * The N strongest, mutually separated peaks in a lag range — what the measurement rig needs, where each
 * peak is a different *phone* playing the same click rather than one phone's arrival.
 *
 * `minSeparationMs` is why this is not just "sort and take N": two phones within ~1 ms of each other
 * merge into a single broad peak (which counts as a pass — they are in sync), and without a separation
 * rule the two shoulders of one peak would be reported as two phones 0.3 ms apart.
 */
export function findPeaks(
  recording: Float32Array,
  template: Float32Array,
  opts: PeakOptions & { count: number; minSeparationMs?: number },
): MultiPeak[] {
  const m = template.length;
  const n = recording.length;
  const from = Math.max(0, Math.floor(opts.fromSample));
  const to = Math.min(n - m, Math.ceil(opts.toSample));
  if (m === 0 || to <= from) return [];

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + recording[i]! * recording[i]!;

  const xc = new Float64Array(to - from);
  for (let lag = from; lag < to; lag++) {
    let num = 0;
    for (let i = 0; i < m; i++) num += recording[lag + i]! * template[i]!;
    const energy = prefix[lag + m]! - prefix[lag]!;
    xc[lag - from] = energy > 0 ? num / Math.sqrt(energy) : 0;
  }

  const sep = Math.max(1, Math.round(((opts.minSeparationMs ?? 1) / 1000) * opts.sampleRate));
  const taken: MultiPeak[] = [];
  const used = new Uint8Array(xc.length);
  for (let k = 0; k < opts.count; k++) {
    let bestIdx = -1;
    let best = -Infinity;
    for (let i = 0; i < xc.length; i++) {
      if (used[i]) continue;
      if (xc[i]! > best) {
        best = xc[i]!;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || best <= 0) break;
    // parabolic refinement, as in findPeak
    let refined = bestIdx;
    if (bestIdx > 0 && bestIdx < xc.length - 1) {
      const denom = xc[bestIdx - 1]! - 2 * xc[bestIdx]! + xc[bestIdx + 1]!;
      if (denom !== 0) {
        const delta = (0.5 * (xc[bestIdx - 1]! - xc[bestIdx + 1]!)) / denom;
        if (Math.abs(delta) <= 1) refined = bestIdx + delta;
      }
    }
    taken.push({ lagSamples: from + refined, value: best });
    for (let i = Math.max(0, bestIdx - sep); i < Math.min(xc.length, bestIdx + sep + 1); i++) used[i] = 1;
  }
  return taken;
}

/** Linear resampling, for a template built at a different rate from the recording. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const out = new Float32Array(Math.max(1, Math.round(input.length * ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

// ---- the calibration pipeline ----------------------------------------------
export interface ClickMeasurement {
  /** Index into `expectedMs` / the click order. */
  index: number;
  /** Where the click was expected, ms into the recording. */
  expectedMs: number;
  /** Where it actually was, ms into the recording. */
  arrivalMs: number;
  /** arrival − expected. Still contains the reference's own constant latency. */
  rawMs: number;
  /** rawMs − median(rawMs of confident clicks). The number the server applies. */
  residualMs: number;
  peak: number;
  secondPeak: number;
  confidence: number;
  prominence: number;
}

export interface AnalyzeOptions {
  recording: Float32Array;
  sampleRate: number;
  /** The click waveform, as `renderClick` produced it at this sample rate. */
  template: Float32Array;
  /** Where each click is expected, ms into the recording (one entry per player, in click order). */
  expectedMs: number[];
  /** Half-width of the search window, ms. Must stay under half the click interval. */
  windowMs?: number;
  /** Clicks below this confidence are excluded from the median (and the server ignores them). */
  minConfidence?: number;
  guardMs?: number;
}

export interface AnalyzeResult {
  clicks: ClickMeasurement[];
  /** The group's common latency, removed from every residual. */
  medianRawMs: number;
  /** How many clicks were confident enough to anchor the median. */
  anchorCount: number;
}

export const DEFAULT_WINDOW_MS = 150;
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Finds every click and turns arrivals into residuals by removing the group median.
 *
 * `residual > 0` means this phone's click reached the reference later than the group's did — the device
 * is late, so its compensation grows. With a single click the residual is 0 by construction, which is
 * correct: one phone is always in unison with itself.
 */
export function analyzeClicks(opts: AnalyzeOptions): AnalyzeResult {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const template = normalizeEnergy(opts.template);
  const perMs = opts.sampleRate / 1000;

  const found = opts.expectedMs.map((expectedMs, index) => {
    const peak = findPeak(opts.recording, template, {
      fromSample: (expectedMs - windowMs) * perMs,
      toSample: (expectedMs + windowMs) * perMs,
      sampleRate: opts.sampleRate,
      guardMs: opts.guardMs,
    });
    const arrivalMs = peak.lagSamples / perMs;
    return {
      index,
      expectedMs,
      arrivalMs,
      rawMs: arrivalMs - expectedMs,
      residualMs: 0,
      peak: peak.peak,
      secondPeak: peak.secondPeak,
      confidence: peak.confidence,
      prominence: peak.prominence,
    } satisfies ClickMeasurement;
  });

  // Only clicks we actually heard may define the group's common latency; a missed click would otherwise
  // drag the anchor and move every other phone.
  const anchors = found.filter((c) => c.confidence >= minConfidence).map((c) => c.rawMs);
  const medianRawMs = median(anchors.length > 0 ? anchors : found.map((c) => c.rawMs));
  for (const c of found) c.residualMs = c.rawMs - medianRawMs;

  return { clicks: found, medianRawMs, anchorCount: anchors.length };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
