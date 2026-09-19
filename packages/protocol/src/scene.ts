import { z } from "zod";
import { MODES } from "./constants";
import { ModeParamsSchema } from "./mode";

export const SceneSchema = z.object({
  /** Track time at which this scene starts. Scenes must be ascending; the first should be 0. */
  atTrackSec: z.number().min(0),
  mode: z.enum(MODES),
  params: ModeParamsSchema.default({}),
  /** Short human label shown on the host's scene strip (e.g. "calm", "build", "drop"). */
  note: z.string().max(40),
});
export type Scene = z.infer<typeof SceneSchema>;

/** Exactly what the Vibe Director LLM call must return (used as the structured-output format). */
export const ScenePlanCoreSchema = z.object({
  scenes: z.array(SceneSchema).min(1).max(12),
});
export type ScenePlanCore = z.infer<typeof ScenePlanCoreSchema>;

/** What the server stores and broadcasts in RoomState.scenePlan. */
export const ScenePlanSchema = ScenePlanCoreSchema.extend({
  prompt: z.string().max(500),
  source: z.enum(["llm", "rules"]),
  createdAtServerTime: z.number(),
}).refine((p) => p.scenes.every((s, i) => i === 0 || s.atTrackSec > p.scenes[i - 1]!.atTrackSec), {
  message: "scenes must have strictly ascending atTrackSec",
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

/** Index of the scene active at trackTimeSec, or -1 before the first scene. */
export function activeSceneIndex(plan: ScenePlan | null | undefined, trackTimeSec: number): number {
  if (!plan) return -1;
  let idx = -1;
  for (let i = 0; i < plan.scenes.length; i++) {
    if (plan.scenes[i]!.atTrackSec <= trackTimeSec) idx = i;
    else break;
  }
  return idx;
}
