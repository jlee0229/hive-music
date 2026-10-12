/**
 * The decisions behind "Start the hive", pulled out of the page so they can be unit-tested: the
 * automatic tuning moment only runs on the real engine (a microphone is involved), which the
 * Playwright suite's stub engine never exercises.
 */
import { CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, type RoomState } from "@hive/protocol";

export type StartPlan =
  /** A start is already in flight (a second tap on Start): do nothing. */
  | { kind: "ignore" }
  /** Start the music now. */
  | { kind: "play" }
  /** Run the tuning moment first, and start the music when it lands or after `failsafeMs` at the latest. */
  | { kind: "tune-then-play"; failsafeMs: number };

/** Speakers that can produce a click worth measuring: connected players with this track decoded. */
export function readyPlayers(room: RoomState): RoomState["clients"][string][] {
  return Object.values(room.clients).filter((c) => c.kind === "player" && c.connected && c.plays && c.audioReadyTrackId === room.track?.id);
}

/**
 * How long a tuning moment with `speakers` phones can legitimately take before the server calls it
 * failed (countdown + one click slot each + its 5 s grace), plus a margin for the round trip. The
 * failsafe must sit after that, or a big party's Start would cut its own tuning short.
 */
export function tuningFailsafeMs(speakers: number): number {
  return CALIBRATION_COUNTDOWN_MS + speakers * CALIBRATION_CLICK_INTERVAL_MS + 5000 + 5000;
}

export function planStart(input: {
  engine: "real" | "stub";
  room: RoomState | null;
  /** An automatic tuning started by an earlier tap has not landed yet. */
  startInFlight: boolean;
  /** The microphone already refused once on this page: asking again would only flash every phone's tuning screen. */
  micBlocked: boolean;
}): StartPlan {
  if (input.startInFlight) return { kind: "ignore" };
  const { room } = input;
  if (!room || input.engine !== "real" || input.micBlocked || room.calibration.state !== "idle") return { kind: "play" };
  const ready = readyPlayers(room);
  if (!ready.some((c) => c.calibratedOffsetMs == null)) return { kind: "play" };
  return { kind: "tune-then-play", failsafeMs: tuningFailsafeMs(ready.length) };
}

/**
 * The one line the stage says about tuning — and only when something is actually wrong. (It used to
 * say "Phones were tuned automatically at start" whether or not a tuning had ever run.)
 */
export function tuningNote(input: { calibrationState: RoomState["calibration"]["state"]; micBlocked: boolean }): string | null {
  if (input.micBlocked) return "Tuning needs this phone’s microphone.";
  if (input.calibrationState === "failed") return "Tuning didn’t finish — try again when the room is quiet.";
  return null;
}

/**
 * Whether the full-screen tuning moment should cover the stage. A run in progress always does. A
 * failed one only if this page started it: `failed` stays in the room until the next run, and a
 * host who reloads must land on the stage, not on an old "Couldn't finish".
 */
export function showTuningScreen(input: { calibrationState: RoomState["calibration"]["state"]; startedHere: boolean; dismissed: boolean }): boolean {
  if (input.dismissed) return false;
  if (input.calibrationState === "countdown" || input.calibrationState === "running") return true;
  return input.calibrationState === "failed" && input.startedHere;
}
