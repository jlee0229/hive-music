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

/**
 * Returns a gain multiplier in [0, 1]. Undefined pattern → 1 (always on).
 *
 * Periodic in both directions: a negative `trackTimeMs` (the lead-in before a start) evaluates the same
 * gate extended backwards, so a phone that schedules early and one that joins late agree. A non-finite
 * time or period cannot be scheduled against; it evaluates to 1 — audible — rather than to NaN, which
 * Web Audio's `setValueCurveAtTime` rejects and which would leave the phone at whatever gain it had.
 *
 * strobe: on for duty·period, with linear ramps **centred on the two edges** of the window — up across
 * [−ramp/2, +ramp/2] around the phase origin, down across the same span around `on`. Two gates whose
 * windows are back to back (group g+1 opens where group g closes) therefore cross-fade and their gains
 * sum to exactly 1 through the handoff. Ramps placed *inside* the window, as they used to be, made both
 * gates zero at the switch instant: a 20 ms hole in the room at every handoff, sitting exactly on the
 * drum hit the switch was aligned to, with the incoming phone still fading in through the attack.
 */
export function evaluatePattern(pattern: Pattern | null | undefined, trackTimeMs: number): number {
  if (!pattern) return 1;
  const period = pattern.periodMs;
  if (!Number.isFinite(trackTimeMs) || !Number.isFinite(period) || !Number.isFinite(pattern.phaseMs) || period <= 0) return 1;
  if (pattern.kind === "wave") {
    // raised cosine swell: 0 at the phase origin, 1 half a period later
    const t = wrap(trackTimeMs - pattern.phaseMs, period);
    return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period);
  }
  const on = (pattern.duty ?? 0.5) * period;
  if (on >= period) return 1; // duty 1 is "always on", not "on with a dip once per period"
  if (on <= 0) return 0;
  // a ramp can be no longer than the window it opens or the gap it closes
  const ramp = Math.min(pattern.rampMs ?? 10, on, period - on);
  const half = ramp / 2;
  // position relative to the window's opening edge, in [−half, period − half)
  const t = wrap(trackTimeMs - pattern.phaseMs + half, period) - half;
  if (t < half) return ramp > 0 ? (t + half) / ramp : 1;
  if (t <= on - half) return 1;
  if (t < on + half) return (on + half - t) / ramp;
  return 0;
}
