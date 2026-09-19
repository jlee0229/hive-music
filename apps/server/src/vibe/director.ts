// The Vibe Director LLM call (docs/05-effect-modes.md §The call). No key, a refusal, a bad parse or the
// 5s timeout all fall back to rules.ts; the host always gets a valid ScenePlan either way.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ScenePlanCoreSchema, ScenePlanSchema, type Scene, type ScenePlan } from "@hive/protocol";
import { normalizeScenes } from "./normalize";
import { SYSTEM_PROMPT, userPrompt, type TrackMetaForPrompt } from "./prompt";
import { rulesFallback, type TrackMeta } from "./rules";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export type VibeTrackMeta = TrackMeta & TrackMetaForPrompt;

export async function directScene(prompt: string, meta: VibeTrackMeta, playerCount: number, currentMode: string, createdAtServerTime: number): Promise<ScenePlan> {
  const wrap = (scenes: Scene[], source: "llm" | "rules"): ScenePlan =>
    ScenePlanSchema.parse({ prompt, source, createdAtServerTime, scenes: normalizeScenes(scenes, meta.durationSec) });

  if (!process.env.ANTHROPIC_API_KEY) return wrap(rulesFallback(prompt, meta), "rules");

  try {
    // @anthropic-ai/sdk's zodOutputFormat types against zod's v4 subpath; ScenePlanCoreSchema is a v3
    // schema (packages/protocol is frozen — not ours to change). They interoperate at runtime (zod 3.25+
    // shares its core with v4), so the casts below are safe; the real validation is `ScenePlanSchema.parse`
    // in `wrap()`, which rejects anything malformed regardless of what parsed_output claims to be.
    const response = (await getClient().messages.parse(
      {
        model: process.env.VIBE_MODEL ?? "claude-sonnet-5",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(prompt, meta, playerCount, currentMode) }],
        output_config: { format: zodOutputFormat(ScenePlanCoreSchema as any) },
      },
      { timeout: 5_000, maxRetries: 0 },
    )) as { stop_reason: string | null; parsed_output: { scenes: Scene[] } | null };
    if (response.stop_reason === "refusal" || response.parsed_output == null) return wrap(rulesFallback(prompt, meta), "rules");
    return wrap(response.parsed_output.scenes, "llm");
  } catch {
    return wrap(rulesFallback(prompt, meta), "rules");
  }
}
