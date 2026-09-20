// Shared energy-curve analysis: same heuristic fixtures/gen-synthetic.ts's drop is checked against,
// used by both the vibe rules fallback and the upload pipeline's meta.json computation.

/** Per-second RMS of the summed stems, normalized so the max is 1.0 (fixtures/gen-synthetic.ts's energyCurve). */
export function energyCurve(stems: Float32Array[], sampleRate: number, durationSec: number): number[] {
  const seconds = Math.ceil(durationSec);
  const rms: number[] = [];
  for (let s = 0; s < seconds; s++) {
    const start = s * sampleRate;
    const end = Math.min((s + 1) * sampleRate, stems[0]?.length ?? 0);
    let acc = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      let sum = 0;
      for (const stem of stems) sum += stem[i] ?? 0;
      acc += sum * sum;
      n++;
    }
    rms.push(n > 0 ? Math.sqrt(acc / n) : 0);
  }
  const max = Math.max(...rms) || 1;
  return rms.map((v) => Number((v / max).toFixed(4)));
}

/**
 * Smooth energy[] with a 3-point moving average, then find the biggest rise (after - before) over a
 * short window. Returns null if there's no rise over the 0.2 threshold (docs/05-effect-modes.md).
 */
export function detectDropFromEnergy(energy: number[] | undefined): number | null {
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
