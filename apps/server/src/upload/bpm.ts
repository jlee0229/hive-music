/**
 * Tempo detection for uploaded tracks (pure TS, no ffmpeg — same constraint as the rest of the
 * upload pipeline). Onset-flux autocorrelation: an RMS envelope at ~86 frames/s, positive flux
 * (energy rises = note onsets), then the autocorrelation peak across the 70–180 BPM lag range,
 * refined with parabolic interpolation. Good enough to lock a strobe to a pop song's beat; a
 * track with no rhythmic content returns whatever correlates best, which the strobe treats the
 * same as any tempo — worst case it flashes steadily, exactly like before tempo sync existed.
 */

const HOP = 512;
const MIN_BPM = 70;
const MAX_BPM = 180;
/** Analyze at most this much audio: plenty for a stable tempo estimate, bounded CPU per upload. */
const MAX_ANALYSIS_SEC = 120;

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
  const flux = new Float32Array(frames);
  let fluxSum = 0;
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, env[f]! - env[f - 1]!);
    fluxSum += flux[f]!;
  }
  if (fluxSum === 0) return null; // silence

  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * frameRate));
  const maxLag = Math.min(frames - 1, Math.ceil((60 / MIN_BPM) * frameRate));
  const corr = new Float32Array(maxLag + 1);
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let f = lag; f < frames; f++) acc += flux[f]! * flux[f - lag]!;
    corr[lag] = acc / (frames - lag);
    if (bestLag === 0 || corr[lag]! > corr[bestLag]!) bestLag = lag;
  }
  if (bestLag <= minLag || bestLag >= maxLag) {
    // A peak pinned to the search boundary is a range artifact, not a tempo.
    if (bestLag === 0) return null;
  }

  // Parabolic refinement: one lag step is ~3 BPM at 120; the vertex gets us well under 1 BPM.
  const y0 = corr[bestLag - 1] ?? corr[bestLag]!;
  const y1 = corr[bestLag]!;
  const y2 = corr[bestLag + 1] ?? corr[bestLag]!;
  const denom = y0 - 2 * y1 + y2;
  const offset = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const lag = bestLag + offset;

  const bpm = (60 * frameRate) / lag;
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) return null;
  return Math.round(bpm * 10) / 10;
}
