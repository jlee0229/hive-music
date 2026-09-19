import { z } from "zod";

/**
 * Deterministic gain patterns evaluated CLIENT-SIDE on the shared timeline.
 * No per-tick messages: every phone computes the same multiplier for the same trackTimeMs.
 */
export const PatternSchema = z.object({
  kind: z.enum(["strobe", "wave"]),
  periodMs: z.number().positive(),
  /** Phase offset in ms; the planner derives it from position so the effect travels across the room. */
  phaseMs: z.number(),
  /** strobe only: fraction of the period the phone is audible (0..1). */
  duty: z.number().min(0).max(1).optional(),
  /** Edge softening in ms for strobe (avoids clicks). */
  rampMs: z.number().min(0).optional(),
});
export type Pattern = z.infer<typeof PatternSchema>;

function wrap(t: number, period: number): number {
  return ((t % period) + period) % period;
}

/** Returns a gain multiplier in [0, 1]. Undefined pattern → 1 (always on). */
export function evaluatePattern(pattern: Pattern | null | undefined, trackTimeMs: number): number {
  if (!pattern) return 1;
  const t = wrap(trackTimeMs - pattern.phaseMs, pattern.periodMs);
  if (pattern.kind === "wave") {
    // raised cosine swell: 0 at the phase origin, 1 half a period later
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / pattern.periodMs);
  }
  // strobe: on for duty·period, with a short linear ramp at both edges
  const duty = pattern.duty ?? 0.5;
  const on = duty * pattern.periodMs;
  const ramp = Math.min(pattern.rampMs ?? 10, on / 2);
  if (t < ramp) return t / ramp;
  if (t < on - ramp) return 1;
  if (t < on) return (on - t) / ramp;
  return 0;
}
