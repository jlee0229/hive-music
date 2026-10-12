/**
 * What the stage's toast says for an `error` event — from the server (`ERROR code message`) or from
 * the engine on this phone (`AUDIO_LOAD_FAILED`). The original `message` is written for a developer
 * ("message failed schema validation", "SET_TRACK first", "stem http://…/mix.wav failed: 404"); the
 * host gets a sentence. NOT_HOST and NO_ROOM never reach the toast — the page handles those as
 * states of their own.
 */

/** How long the toast stays up. It used to stay until the page was reloaded. */
export const HOST_TOAST_MS = 6000;

const TEXT: Record<string, string> = {
  NO_TRACK: "Pick a song first.",
  CALIBRATION_BUSY: "Tuning is still running.",
  NO_CLIENT: "That phone has left the hive.",
  KICKED: "This phone was removed from the hive.",
  BAD_MESSAGE: "That didn’t go through — try again.",
  // From the engine, about this phone's own audio (it retries the download by itself).
  AUDIO_LOAD_FAILED: "This phone is having trouble loading the song.",
};

const GENERIC = "Something went wrong — try again.";

/** Text that would mean nothing to a host: URLs, paths, identifiers, code-ish punctuation. */
function looksTechnical(message: string): boolean {
  return /https?:|wss?:|\/\w+\/\w|\b[A-Z]{2,}_[A-Z_]+\b|[{}<>=]|\bundefined\b|\bnull\b|Error\b|\b[45]\d\d\b/.test(message);
}

export function hostErrorText(code: string, message: string): string {
  const known = TEXT[code];
  if (known) return known;
  return !message || looksTechnical(message) ? GENERIC : message;
}
