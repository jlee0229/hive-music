// Server normalisation before wrapping a raw scene list into a ScenePlan (docs/05-effect-modes.md).
import type { Scene } from "@hive/protocol";

export function normalizeScenes(scenes: Scene[], durationSec: number): Scene[] {
  let out = [...scenes].sort((a, b) => a.atTrackSec - b.atTrackSec).filter((s) => s.atTrackSec < durationSec);
  if (out.length === 0 || out[0]!.atTrackSec !== 0) {
    out = [{ atTrackSec: 0, mode: "UNISON", params: {}, note: "open" }, ...out];
  }
  const merged: Scene[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.atTrackSec - prev.atTrackSec < 2) merged[merged.length - 1] = s; // closer than 2s: keep the later one
    else merged.push(s);
  }
  return merged;
}
