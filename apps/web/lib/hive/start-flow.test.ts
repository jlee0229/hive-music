// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { IDLE_CALIBRATION, PROTOCOL_VERSION, type ClientRecord, type RoomState } from "@hive/protocol";
import { planStart, showTuningScreen, tuningCancelLabel, tuningFailsafeMs, tuningNote } from "./start-flow";

function player(i: number, over: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: `player-${String(i).padStart(3, "0")}`, kind: "player", plays: true, name: `P${i}`,
    device: { userAgent: "", platform: "test", browserFamily: "other" },
    joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0,
    tableLatencyMs: null, calibratedOffsetMs: null, assignment: null, connected: true, audioReadyTrackId: "t1",
    ...over,
  };
}

function room(clients: ClientRecord[], calibration: RoomState["calibration"]["state"] = "idle"): RoomState {
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t1", title: "T", durationSec: 60, stems: ["mix"] },
    transport: { state: "stopped" }, mode: { kind: "UNISON", params: {} }, scenePlan: null,
    calibration: { ...IDLE_CALIBRATION, state: calibration },
    clients: Object.fromEntries(clients.map((c) => [c.id, c])),
  };
}

const base = { engine: "real" as const, startInFlight: false, micBlocked: false };

describe("planStart", () => {
  test("untuned ready players on the real engine: tune first, then play", () => {
    expect(planStart({ ...base, room: room([player(1), player(2)]) })).toEqual({ kind: "tune-then-play", failsafeMs: tuningFailsafeMs(2) });
  });

  test("a second tap while the first start's tuning has not landed is ignored (no second mic, no second click schedule)", () => {
    expect(planStart({ ...base, startInFlight: true, room: room([player(1)]) })).toEqual({ kind: "ignore" });
  });

  test("nothing to tune -> play at once: no players, everyone tuned, nobody ready, players that left", () => {
    expect(planStart({ ...base, room: room([]) }).kind).toBe("play");
    expect(planStart({ ...base, room: room([player(1, { calibratedOffsetMs: 12 })]) }).kind).toBe("play");
    expect(planStart({ ...base, room: room([player(1, { audioReadyTrackId: null })]) }).kind).toBe("play");
    expect(planStart({ ...base, room: room([player(1, { connected: false })]) }).kind).toBe("play");
    expect(planStart({ ...base, room: null }).kind).toBe("play");
  });

  test("the stub engine has no microphone, so it never tunes", () => {
    expect(planStart({ ...base, engine: "stub", room: room([player(1)]) }).kind).toBe("play");
  });

  test("a microphone that already refused is not asked again on every Start", () => {
    expect(planStart({ ...base, micBlocked: true, room: room([player(1)]) }).kind).toBe("play");
  });

  test("a tuning already running (or one that ended) is not restarted by Start", () => {
    for (const s of ["countdown", "running", "done", "failed"] as const) {
      expect(planStart({ ...base, room: room([player(1)], s) }).kind).toBe("play");
    }
  });
});

describe("tuningFailsafeMs", () => {
  test("always later than the server's own verdict, even at a full 64-phone party (the old fixed 30 s was not)", () => {
    for (const n of [1, 12, 30, 64]) {
      const serverVerdictMs = 3000 + n * 400 + 5000;
      expect(tuningFailsafeMs(n)).toBeGreaterThan(serverVerdictMs);
    }
    expect(3000 + 64 * 400 + 5000).toBeGreaterThan(30_000);
  });
});

describe("tuningNote", () => {
  test("says nothing unless something is wrong — never claims a tuning that did not happen", () => {
    for (const s of ["idle", "countdown", "running", "done"] as const) expect(tuningNote({ calibrationState: s, micBlocked: false })).toBeNull();
  });
  test("a failed run and a blocked microphone each get one short line", () => {
    expect(tuningNote({ calibrationState: "failed", micBlocked: false })).toMatch(/didn.t finish/);
    expect(tuningNote({ calibrationState: "idle", micBlocked: true })).toMatch(/microphone/);
  });
});

describe("tuningCancelLabel", () => {
  test("during Start's automatic tuning the button starts the music untuned, and says so", () => {
    expect(tuningCancelLabel({ autoStart: true })).toBe("Skip tuning");
  });
  test("a tuning the host asked for is cancelled", () => {
    expect(tuningCancelLabel({ autoStart: false })).toBe("Cancel");
  });
});

describe("showTuningScreen", () => {
  test("a run in progress covers the stage until dismissed", () => {
    expect(showTuningScreen({ calibrationState: "countdown", startedHere: false, dismissed: false })).toBe(true);
    expect(showTuningScreen({ calibrationState: "running", startedHere: true, dismissed: false })).toBe(true);
    expect(showTuningScreen({ calibrationState: "running", startedHere: true, dismissed: true })).toBe(false);
  });
  test("an old failure left in the room does not greet a reloading host", () => {
    expect(showTuningScreen({ calibrationState: "failed", startedHere: false, dismissed: false })).toBe(false);
    expect(showTuningScreen({ calibrationState: "failed", startedHere: true, dismissed: false })).toBe(true);
  });
  test("idle and done never show it", () => {
    expect(showTuningScreen({ calibrationState: "idle", startedHere: true, dismissed: false })).toBe(false);
    expect(showTuningScreen({ calibrationState: "done", startedHere: true, dismissed: false })).toBe(false);
  });
});
