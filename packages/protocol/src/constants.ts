/**
 * @hive/protocol — constants shared by server, sync-client, mock server and UI.
 * Every number here is quoted in docs/02-protocol.md; change both or neither.
 */

export const PROTOCOL_VERSION = 3 as const;

// ---- timeline & scheduling --------------------------------------------------
/** PLAY is scheduled this far ahead so every phone can line up on the same instant. */
export const LEAD_MS = 600;
/** Hard resync (20 ms crossfade) when |playhead error| exceeds this. */
export const RESYNC_THRESHOLD_MS = 10;
export const RESYNC_CROSSFADE_MS = 20;

// ---- playbackRate slewing (B9e) ---------------------------------------------
/*
 * A phone's audio clock is not its system clock: a crystal 50 ppm fast consumes 3 ms of extra content
 * per minute, which crosses RESYNC_THRESHOLD_MS every ~3.5 minutes and buys an audible crossfade each
 * time. Trimming `source.playbackRate` by a few hundred ppm removes the error before it is ever worth
 * correcting — the same trade every wireless multiroom system makes. The hard resync stays as the
 * fallback for what slewing cannot absorb (a clock step, a resumed tab, a seek).
 */
/** Whether the drift check trims playbackRate. Off keeps the pure B4 behaviour (crossfade only). */
export const PLAYBACK_RATE_SLEW_DEFAULT = true;
/** Cap on the trim, parts per million. 500 ppm = 0.5 ms/s of correction and 0.87 cents of pitch shift. */
export const PLAYBACK_RATE_MAX_PPM = 500;
/** Below this |error| the rate returns to exactly 1: a deadband, so measurement noise is not chased. */
export const PLAYBACK_RATE_DEADBAND_MS = 0.5;
/** Target time to null out the error, seconds. Must be ≥ 2 drift-check intervals or the loop hunts. */
export const PLAYBACK_RATE_TAU_SEC = 2;
/** Engineering targets quoted everywhere: device-to-device after calibration / acceptable floor. */
export const SYNC_TARGET_MS = 10;
export const SYNC_FLOOR_MS = 30;

// ---- clock sync (NTP-style over the room WebSocket) -------------------------
export const NTP_BURST_COUNT = 20;
export const NTP_BURST_WINDOW_MS = 4000;
export const NTP_STEADY_INTERVAL_MS = 1000;
/** Sliding window of probes over which min-RTT selection runs. */
export const NTP_WINDOW = 30;
/**
 * A sample older than this is dropped from that window regardless of its RTT.
 *
 * min-RTT selection has no notion of age, so one lucky low-RTT sample wins until it is shifted out — and
 * an *offset* goes stale with time: the local clock drifts against the server (50 ppm is 3 ms/minute), so
 * a sample from before a resumed tab, a reconnect or a server restart can pin the clock tens of ms wrong
 * while reporting an excellent RTT. At the steady 1 Hz probe rate this bound is the window itself
 * (30 samples ≈ 30 s), so it changes nothing in normal operation and only bites where it should: after a
 * gap in probing.
 */
export const NTP_SAMPLE_MAX_AGE_MS = 30_000;
/** Coded probe pairs: inter-departure gap; pairs whose server-side gap differs by more than the tolerance are dropped. */
export const NTP_PROBE_PAIR_GAP_MS = 10;
export const NTP_PROBE_PAIR_TOLERANCE_MS = 2;

// ---- traffic caps -----------------------------------------------------------
export const ROOM_STATE_MAX_HZ = 2;
export const HEALTH_HZ = 1;
export const SET_POSITION_MAX_HZ = 10;
export const CLIENT_STATUS_INTERVAL_MS = 2000;
export const PING_INTERVAL_MS = 20_000;

// ---- lifetimes --------------------------------------------------------------
export const DISCONNECT_RETENTION_MS = 120_000;
export const ROOM_IDLE_TTL_MS = 600_000;

// ---- health thresholds (healthLevel) ----------------------------------------
export const HEALTH_GOOD_MS = 5;
export const HEALTH_WARN_MS = 20;
export const HEALTH_STALE_MS = 5000;

// ---- calibration ------------------------------------------------------------
export const CALIBRATION_CLICK_INTERVAL_MS = 400;
export const CALIBRATION_COUNTDOWN_MS = 3000;
export const NUDGE_RANGE_MS = 100;

// ---- modes, stems, roles, colors -------------------------------------------
export const MODES = ["UNISON", "ORCHESTRA", "STEREO", "WAVE", "STROBE"] as const;
export type ModeKind = (typeof MODES)[number];

/** Canonical stem order. A non-separated track is a one-stem track named "mix". */
export const STEMS = ["drums", "bass", "vocals", "other"] as const;
export type StemName = (typeof STEMS)[number] | "mix";

export const ROLES = ["drums", "bass", "vocals", "other", "unison"] as const;
export type Role = (typeof ROLES)[number];

/** Source of truth for every role color in the UI (docs/05, docs/06, Hive Map, player screens). */
export const ROLE_COLORS: Record<Role, string> = {
  drums: "#F59E0B",
  bass: "#8B5CF6",
  vocals: "#22D3EE",
  other: "#34D399",
  unison: "#F8FAFC",
};
export const HOST_RING_COLOR = "#F1F5F9";

export const HEALTH_LEVELS = ["good", "warn", "bad", "unknown"] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];
export const HEALTH_COLORS: Record<HealthLevel, string> = {
  good: "#22C55E",
  warn: "#EAB308",
  bad: "#EF4444",
  unknown: "#64748B",
};

export const WAVE_SPAN_MAX_MS = 300;
export const WAVE_DEFAULT_SPAN_MS = 240;
export const WAVE_SWELL_PERIOD_MS = 2000;
export const STROBE_DEFAULT_PERIOD_MS = 500;
export const STROBE_DEFAULT_DUTY = 0.5;

// ---- devices ----------------------------------------------------------------
export const BROWSER_FAMILIES = ["ios-safari", "android-chrome", "desktop-chrome", "desktop-safari", "other"] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

/**
 * Tier-1 latency table: total output latency guess per browser family, ms.
 * STARTER GUESSES — the backend agent replaces these with measured values (gate B4).
 * null = unknown; the sync-client then falls back to AudioContext.outputLatency.
 */
export const STARTER_LATENCY_TABLE_MS: Record<BrowserFamily, number | null> = {
  "ios-safari": 60,
  "android-chrome": 45,
  "desktop-chrome": 25,
  "desktop-safari": 30,
  other: null,
};

// ---- rooms ------------------------------------------------------------------
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;
export const MAX_PLAYERS = 64;
