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
/** Engineering targets quoted everywhere: device-to-device after calibration / acceptable floor. */
export const SYNC_TARGET_MS = 10;
export const SYNC_FLOOR_MS = 30;

// ---- clock sync (NTP-style over the room WebSocket) -------------------------
export const NTP_BURST_COUNT = 20;
export const NTP_BURST_WINDOW_MS = 4000;
export const NTP_STEADY_INTERVAL_MS = 1000;
/** Sliding window of probes over which min-RTT selection runs. */
export const NTP_WINDOW = 30;
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
