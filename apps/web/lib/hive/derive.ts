/** Pure helpers over a RoomState snapshot. No side effects, no client access — easy to unit-test and reuse. */
import {
  activeSceneIndex,
  evaluatePattern,
  healthLevel,
  type AudioState,
  type ClientRecord,
  type HealthLevel,
  type HealthSnapshot,
  type Pattern,
  type RoomState,
} from "@hive/protocol";
import type { SyncStatus } from "@hive/sync-client";

export function healthFor(health: Record<string, HealthSnapshot>, id: string, nowServerTime: number): HealthLevel {
  return healthLevel(health[id] ?? null, nowServerTime);
}

/** A player has no HEALTH broadcast of its own (hosts-only); build the same shape from its live status instead. */
export function selfHealthLevel(status: SyncStatus, audioState: AudioState, nowServerTime: number): HealthLevel {
  return healthLevel(
    { rttMs: status.rttMs, syncErrMs: status.syncErrMs, outputLatencyMs: status.outputLatencyMs, audioState, lastSeenServerTime: nowServerTime },
    nowServerTime,
  );
}

export function sceneNowIndex(room: RoomState | null, trackTimeSecNow: number): number {
  return room ? activeSceneIndex(room.scenePlan, trackTimeSecNow) : -1;
}

/** 0..1 phase within the current beat, or 0 with no bpm. */
export function beatPhase(trackTimeSecNow: number, bpm: number | undefined | null): number {
  if (!bpm) return 0;
  const beatSec = 60 / bpm;
  return (trackTimeSecNow % beatSec) / beatSec;
}

export function patternGain(pattern: Pattern | null | undefined, trackTimeSecNow: number): number {
  return evaluatePattern(pattern, trackTimeSecNow * 1000);
}

export function stems(room: RoomState | null): string[] {
  return room?.track?.stems ?? [];
}

/** Speakers (plays:true) that have not been placed on the Hive Map yet. */
export function unplacedSpeakers(room: RoomState | null): ClientRecord[] {
  if (!room) return [];
  return Object.values(room.clients)
    .filter((c) => c.plays && c.position === null)
    .sort((a, b) => a.joinIndex - b.joinIndex);
}

export function placedSpeakers(room: RoomState | null): ClientRecord[] {
  if (!room) return [];
  return Object.values(room.clients)
    .filter((c) => c.plays && c.position !== null)
    .sort((a, b) => a.joinIndex - b.joinIndex);
}

/** Every client sorted by join order (Players drawer re-sorts by health itself). */
export function allClients(room: RoomState | null): ClientRecord[] {
  if (!room) return [];
  return Object.values(room.clients).sort((a, b) => a.joinIndex - b.joinIndex);
}

export function healthRank(level: HealthLevel): number {
  switch (level) {
    case "bad":
      return 0;
    case "warn":
      return 1;
    case "unknown":
      return 2;
    case "good":
      return 3;
  }
}

/** Players sorted worst-health-first, the order the Players drawer shows. */
export function sortedByHealth(room: RoomState | null, health: Record<string, HealthSnapshot>, nowServerTime: number): ClientRecord[] {
  return allClients(room).sort((a, b) => healthRank(healthFor(health, a.id, nowServerTime)) - healthRank(healthFor(health, b.id, nowServerTime)));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const sign = ms > 0 ? "+" : ms < 0 ? "" : "±";
  return `${sign}${Math.round(ms)} ms`;
}

export function formatClockErr(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `±${Math.round(ms)} ms`;
}

export function formatTrackTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function deviceLabel(device: ClientRecord["device"]): string {
  switch (device.browserFamily) {
    case "ios-safari":
      return "iPhone · Safari";
    case "android-chrome":
      return "Android · Chrome";
    case "desktop-chrome":
      return "Desktop · Chrome";
    case "desktop-safari":
      return "Desktop · Safari";
    default:
      return device.model ?? "Unknown device";
  }
}
