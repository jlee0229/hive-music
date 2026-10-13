// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { ROOM_LOST_GIVE_UP_MS, rejoinDelayMs, stillWaitingForRoom } from "./room-lost";

describe("PARTY-01: a guest whose hive went missing keeps asking, gently, for about five minutes", () => {
  test("5 s, 10 s, 20 s, then every 30 s", () => {
    expect([0, 1, 2, 3, 4, 9, 50].map((n) => rejoinDelayMs(n, () => 0))).toEqual([5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]);
  });

  test("never sooner than the nominal wait, at most 20 % later", () => {
    for (let n = 0; n < 8; n++) {
      const nominal = rejoinDelayMs(n, () => 0);
      expect(rejoinDelayMs(n, () => 0.999)).toBeGreaterThan(nominal);
      expect(rejoinDelayMs(n, () => 0.999)).toBeLessThanOrEqual(nominal * 1.2);
    }
  });

  test("one phone asks about a dozen times before it gives up — not a hundred", () => {
    let t = 0;
    let asks = 0;
    while (stillWaitingForRoom(0, t)) {
      t += rejoinDelayMs(asks++, () => 0.5);
    }
    expect(asks).toBeGreaterThanOrEqual(10);
    expect(asks).toBeLessThanOrEqual(14);
    // at the steady pace a phone asks twice a minute
    expect(60_000 / rejoinDelayMs(10, () => 0)).toBe(2);
  });

  test("it waits for five minutes from the first refusal, then stops", () => {
    expect(stillWaitingForRoom(1000, 1000)).toBe(true);
    expect(stillWaitingForRoom(1000, 1000 + ROOM_LOST_GIVE_UP_MS - 1)).toBe(true);
    expect(stillWaitingForRoom(1000, 1000 + ROOM_LOST_GIVE_UP_MS)).toBe(false);
    expect(ROOM_LOST_GIVE_UP_MS).toBe(300_000);
  });
});
