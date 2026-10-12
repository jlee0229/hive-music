/**
 * Pure timeline math shared by the real server and the mock: which scene is current, when the next one
 * fires, and which track follows the one that just ended. No timers, no clocks — callers pass `serverNow`.
 *
 * `nextScene` / `currentScene` are the functions `apps/server/src/scene-timer.ts` has carried since B5s,
 * moved here unchanged so the mock can run the same scene timer instead of none at all; the playlist
 * rotation is `Room.loopBack`'s rule lifted out of the class for the same reason.
 */
import { LEAD_MS } from "./constants";
import { trackTimeSec, type Transport } from "./room";
import type { Scene, ScenePlan } from "./scene";

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

/**
 * Playlist rotation: the track that follows `currentId` in library order, wrapping. Real songs only — a
 * party never lands on a synthetic test track unless the library holds nothing else. Returns null when
 * there is nothing to advance to (an empty library, or the current track is the only candidate): the
 * caller then loops the current track.
 */
export function nextInRotation<T extends { id: string; generated?: boolean }>(library: readonly T[], currentId: string): T | null {
  const real = library.filter((t) => !t.generated);
  const pool = real.length > 0 ? real : library;
  if (pool.length === 0) return null;
  const idx = pool.findIndex((t) => t.id === currentId);
  const next = pool[(idx + 1) % pool.length]!;
  return next.id === currentId ? null : next;
}

/**
 * `serverTimeAtTrackZero` for a seamless restart of the same track at `endServerTime` (the old end).
 * A boundary that is too close or already past — a SEEK beyond the end — restarts with the standard lead
 * instead: a track zero in the past would start mid-track.
 */
export function loopRestartZero(endServerTime: number, serverNow: number): number {
  return endServerTime > serverNow + 100 ? endServerTime : serverNow + LEAD_MS;
}
