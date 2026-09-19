// Pure scene-timer math, unit-testable with a fake clock; apps/server/src/rooms.ts wires it to real timers.
import { LEAD_MS, trackTimeSec, type Scene, type ScenePlan, type Transport } from "@hive/protocol";

export interface ArmedScene {
  scene: Scene;
  /** Absolute server time to fire the mode switch: boundaryServerTime − LEAD_MS. */
  fireAtServerTime: number;
  /** Absolute server time of the scene boundary itself — assignment.applyAtServerTime. */
  boundaryServerTime: number;
}

/** The next scene boundary strictly after the current track position, or null if not playing / none ahead. */
export function nextScene(plan: ScenePlan | null, transport: Transport, serverNow: number): ArmedScene | null {
  if (!plan || transport.state !== "playing") return null;
  const posSec = trackTimeSec(transport, serverNow);
  const upcoming = plan.scenes.find((s) => s.atTrackSec > posSec);
  if (!upcoming) return null;
  const boundaryServerTime = transport.serverTimeAtTrackZero + upcoming.atTrackSec * 1000;
  return { scene: upcoming, fireAtServerTime: boundaryServerTime - LEAD_MS, boundaryServerTime };
}

/** The scene that should be the current mode right now (at or before the position), or null before the first scene. */
export function currentScene(plan: ScenePlan | null, transport: Transport, serverNow: number): Scene | null {
  if (!plan) return null;
  const posSec = trackTimeSec(transport, serverNow);
  let cur: Scene | null = null;
  for (const s of plan.scenes) {
    if (s.atTrackSec <= posSec) cur = s;
    else break;
  }
  return cur;
}
