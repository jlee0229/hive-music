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

/**
 * `syncErrMs := minRttMs/2 + max(|lastAppliedCorrectionMs|, |playheadErrorMs|)` — the number
 * `CLIENT_STATUS` reports, and an upper bound on how far this phone may be from the server timeline.
 *
 * `playheadErrorMs` is additive (default 0, so the two-argument call is unchanged) and exists because
 * B9e's rate slewing removed the only signal the old formula had. Before slewing, drift *always* ended in
 * a hard resync, so `lastAppliedCorrectionMs` eventually reported it. Now sub-threshold drift is absorbed
 * continuously and never becomes a correction — which is the point — but it also means a phone whose trim
 * is saturated (a clock worse than `PLAYBACK_RATE_MAX_PPM`, or a wrong compensation being mistaken for
 * drift) would sit at 9 ms of real error and report itself green until the moment it finally crossfades.
 *
 * `max` rather than a sum: the two are measurements of the *same* quantity at different times, not
 * independent error sources, so adding them would double-count. The correction term is kept because it is
 * still the right pessimism immediately after a resync, before the next drift check has run.
 */
export function computeSyncErrMs(
  minRttMs: number,
  lastAppliedCorrectionMs: number,
  playheadErrorMs = 0,
): number {
  return minRttMs / 2 + Math.max(Math.abs(lastAppliedCorrectionMs), Math.abs(playheadErrorMs));
}
