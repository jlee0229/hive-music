import { z } from "zod";
import { MODES, STROBE_DEFAULT_DUTY, STROBE_DEFAULT_PERIOD_MS, WAVE_DEFAULT_SPAN_MS, WAVE_SPAN_MAX_MS } from "./constants";

/** Mode parameters. Unknown keys are stripped; every field is optional so `{}` is always valid. */
export const ModeParamsSchema = z.object({
  /** WAVE: which axis of the map the delay grows along. */
  axis: z.enum(["x", "y"]).optional(),
  /** WAVE: delay at the far end of the axis, ms (0..WAVE_SPAN_MAX_MS). */
  spanMs: z.number().min(0).max(WAVE_SPAN_MAX_MS).optional(),
  /** STROBE: on/off period in ms. */
  periodMs: z.number().min(100).max(8000).optional(),
  /** STROBE: fraction of the period each phone is audible. */
  duty: z.number().min(0.05).max(1).optional(),
  /** STROBE: number of phase groups the phones are split into. */
  groups: z.number().int().min(1).max(8).optional(),
  /**
   * STROBE: beats each group stays audible when the track's tempo is known — 2 = half note,
   * 1 = quarter, 0.5 = eighth, 0.25 = sixteenth (4/4 assumed). Ignored without a bpm.
   */
  beatsPerSwitch: z.number().min(0.25).max(4).optional(),
  /** Any mode: global per-stem trim in dB applied on top of the mode's gains. */
  stemGainsDb: z.record(z.string(), z.number().min(-60).max(12)).optional(),
});
export type ModeParams = z.infer<typeof ModeParamsSchema>;

export const ModeSchema = z.object({
  kind: z.enum(MODES),
  params: ModeParamsSchema.default({}),
});
export type Mode = z.infer<typeof ModeSchema>;

export const DEFAULT_MODE: Mode = { kind: "UNISON", params: {} };

/** Fills mode-specific defaults so the planner and the UI agree on what "unset" means. */
export function resolveModeParams(mode: Mode): Required<Pick<ModeParams, "axis" | "spanMs" | "periodMs" | "duty" | "groups" | "beatsPerSwitch">> & ModeParams {
  const p = mode.params ?? {};
  return {
    ...p,
    axis: p.axis ?? "x",
    spanMs: p.spanMs ?? WAVE_DEFAULT_SPAN_MS,
    periodMs: p.periodMs ?? STROBE_DEFAULT_PERIOD_MS,
    duty: p.duty ?? STROBE_DEFAULT_DUTY,
    groups: p.groups ?? 2,
    beatsPerSwitch: p.beatsPerSwitch ?? 1,
  };
}
