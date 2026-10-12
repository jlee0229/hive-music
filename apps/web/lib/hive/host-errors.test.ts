// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { hostErrorText } from "./host-errors";

describe("hostErrorText", () => {
  test("known server codes become sentences; developer wording never reaches the host", () => {
    expect(hostErrorText("BAD_MESSAGE", "message failed schema validation")).not.toMatch(/schema/);
    expect(hostErrorText("NO_TRACK", "SET_TRACK first")).toBe("Pick a song first.");
    expect(hostErrorText("CALIBRATION_BUSY", "cannot reset while calibration is running: cancel first")).toBe("Tuning is still running.");
  });

  test("the engine's AUDIO_LOAD_FAILED never shows a stem URL or a status code", () => {
    const text = hostErrorText("AUDIO_LOAD_FAILED", "stem http://localhost:8080/audio/baby-1a2b3c4d/mix.wav failed: 404");
    expect(text).toBe("This phone is having trouble loading the song.");
    expect(text).not.toMatch(/http|wav|404/);
  });

  test("an unknown code shows the message only when it reads like a sentence", () => {
    expect(hostErrorText("SOMETHING_NEW", "the server said this")).toBe("the server said this");
    expect(hostErrorText("SOMETHING_NEW", "")).toMatch(/try again/);
    for (const technical of [
      "stem https://api.example.com/audio/x/drums.wav failed: 503",
      "decodeAudioData: EncodingError",
      "TypeError: Failed to fetch",
      "unexpected token < in JSON",
      "NOT_ALLOWED_HERE",
      "ws://localhost:8080/ws closed",
      "upstream returned 502",
    ]) {
      expect(hostErrorText("SOMETHING_NEW", technical)).toBe("Something went wrong — try again.");
    }
  });
});
