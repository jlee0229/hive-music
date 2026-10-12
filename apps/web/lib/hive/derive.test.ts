// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { stableGains } from "./derive";

describe("stableGains", () => {
  test("no patterns on screen: the very same object comes back, frame after frame (so React skips the render)", () => {
    const prev = {};
    expect(stableGains(prev, {})).toBe(prev);
  });

  test("a stopped Wave/Strobe (gains not moving) is stable too", () => {
    const prev = { a: 0.5, b: 1 };
    expect(stableGains(prev, { a: 0.5, b: 1 })).toBe(prev);
    expect(stableGains(prev, { a: 0.5004, b: 0.9996 })).toBe(prev); // below 1/100 of full opacity
  });

  test("a visible change, a new phone or a phone leaving produces the new object", () => {
    const prev = { a: 0.5, b: 1 };
    const moved = { a: 0.52, b: 1 };
    expect(stableGains(prev, moved)).toBe(moved);
    const joined = { a: 0.5, b: 1, c: 1 };
    expect(stableGains(prev, joined)).toBe(joined);
    const left = { a: 0.5 };
    expect(stableGains(prev, left)).toBe(left);
    const swapped = { a: 0.5, c: 1 };
    expect(stableGains(prev, swapped)).toBe(swapped);
  });
});
