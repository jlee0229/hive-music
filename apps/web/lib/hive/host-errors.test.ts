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
  test("an unknown code falls back to the server's message, and to a generic line when there is none", () => {
    expect(hostErrorText("SOMETHING_NEW", "the server said this")).toBe("the server said this");
    expect(hostErrorText("SOMETHING_NEW", "")).toMatch(/try again/);
  });
});
