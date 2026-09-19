import { HEALTH_GOOD_MS, HEALTH_STALE_MS, HEALTH_WARN_MS, type HealthLevel } from "./constants";

export type AudioState = "locked" | "unlocked" | "loading" | "ready";

/** What a client reports in CLIENT_STATUS, plus the server-stamped lastSeen. */
export interface ClientHealth {
  rttMs: number | null;
  syncErrMs: number | null;
  outputLatencyMs: number | null;
  audioState: AudioState;
  /** Server time (ms) when the last CLIENT_STATUS / PONG arrived. */
  lastSeenServerTime: number;
}

/**
 * The one place that turns numbers into a color. good ≤5 ms, warn ≤20 ms, bad above;
 * stale (>5 s since last seen) is bad; missing data is unknown.
 */
export function healthLevel(h: ClientHealth | null | undefined, nowServerTime: number): HealthLevel {
  if (!h) return "unknown";
  if (nowServerTime - h.lastSeenServerTime > HEALTH_STALE_MS) return "bad";
  if (h.syncErrMs == null) return "unknown";
  if (h.syncErrMs <= HEALTH_GOOD_MS) return "good";
  if (h.syncErrMs <= HEALTH_WARN_MS) return "warn";
  return "bad";
}

/** syncErrMs := minRttMs/2 + |lastAppliedCorrectionMs| — the number CLIENT_STATUS reports. */
export function computeSyncErrMs(minRttMs: number, lastAppliedCorrectionMs: number): number {
  return minRttMs / 2 + Math.abs(lastAppliedCorrectionMs);
}
