/**
 * What the stage's toast says for a server `ERROR`. The server's own `message` is written for a
 * developer ("message failed schema validation", "SET_TRACK first"); the host gets a sentence.
 * NOT_HOST and NO_ROOM never reach the toast — the page handles those as states of their own.
 */

/** How long the toast stays up. It used to stay until the page was reloaded. */
export const HOST_TOAST_MS = 6000;

const TEXT: Record<string, string> = {
  NO_TRACK: "Pick a song first.",
  CALIBRATION_BUSY: "Tuning is still running.",
  NO_CLIENT: "That phone has left the hive.",
  KICKED: "This phone was removed from the hive.",
  BAD_MESSAGE: "That didn’t go through — try again.",
};

export function hostErrorText(code: string, message: string): string {
  return TEXT[code] ?? (message || "Something went wrong — try again.");
}
