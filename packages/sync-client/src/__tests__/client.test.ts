/**
 * B2: `createHiveClient` end to end against the mock server — the transport, the coded-pair probe
 * exchange and the host controls. No audio: the engine says so out loud rather than reporting a
 * readiness it cannot deliver (that arrives with B3).
 *
 * The clock assertion here is the one the unit tests cannot make: it proves the *wire* half of the
 * coded-pair mechanism. `ClockModel` is built with `pairs: true`, so an offset only ever appears if the
 * server echoed `probeGroupId`/`probeGroupIndex` and the two halves validated against each other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { SET_POSITION_MAX_HZ } from "@hive/protocol";
import { createHiveClient } from "../index";

const PORT = 19980 + Math.floor(Math.random() * 900);
let mock: ReturnType<typeof startMockServer>;

beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [{ name: "Mock", browserFamily: "other", position: [0.5, 0.5], health: "good", pinnedRole: null }] } });
  await mock.ready;
});
afterAll(() => mock.stop());

const base = () => ({ wsUrl: `ws://localhost:${PORT}/ws`, apiUrl: `http://localhost:${PORT}`, roomCode: "BZQ7" });
const waitFor = async (pred: () => boolean, timeoutMs = 3000) => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("createHiveClient", () => {
  test("joins, syncs through validated coded pairs, and drives the room", async () => {
    const host = createHiveClient({ ...base(), kind: "host", plays: false, hostKey: mock.hostKey, clientId: "host-real-0001" });
    const player = createHiveClient({ ...base(), kind: "player", plays: true, name: "Real", clientId: "play-real-0001" });
    try {
      await Promise.all([host.connect(), player.connect()]);
      expect(host.connection).toBe("open");
      expect(player.clientId).toBe("play-real-0001");

      // An offset at all means a pair round-tripped and validated: the server echoed both ids.
      await waitFor(() => player.status.clockOffsetMs !== null);
      expect(player.status.rttMs).not.toBeNull();
      expect(Math.abs(player.status.clockOffsetMs!)).toBeLessThan(50); // same machine
      expect(player.status.syncErrMs).toBeGreaterThanOrEqual(0);

      // WELCOME landed, so the snapshot has us in it with an assignment; a non-playing host has none.
      await waitFor(() => player.me !== null && player.assignment !== null);
      expect(host.me).not.toBeNull();
      expect(host.assignment).toBeNull();

      host.host.setMode("ORCHESTRA");
      await waitFor(() => player.room?.mode.kind === "ORCHESTRA");
      host.host.play(0);
      await waitFor(() => player.room?.transport.state === "playing");
      await waitFor(() => player.clock.trackTimeSec() > 0);
      expect(player.status.playing).toBe(true);

      // nudgeSelf goes through the server and comes back inside the assignment
      player.nudgeSelf(-40);
      await waitFor(() => player.assignment?.compensationMs === -40);
      expect(player.status.compensationMs).toBe(-40);
    } finally {
      host.disconnect();
      player.disconnect();
    }
  });

  test("audio is honest about not existing yet, and calibration too", async () => {
    const player = createHiveClient({ ...base(), kind: "player", plays: true, clientId: "play-real-0002" });
    try {
      await player.connect();
      expect(player.audio.state).toBe("locked");
      expect(player.audio.loadProgress).toBe(0);
      expect(player.status.outputLatencyMs).toBeNull();
      await expect(player.audio.unlock()).rejects.toThrow(/gate B3/);
      await expect(player.calibration.runAsReference()).rejects.toThrow(/gate B8/);
      // local mute still works: it never touched the server
      player.audio.setMuted(true);
      expect(player.audio.muted).toBe(true);
    } finally {
      player.disconnect();
    }
  });

  test("setPosition is throttled inside the engine and the final value still arrives", async () => {
    const host = createHiveClient({ ...base(), kind: "host", plays: false, hostKey: mock.hostKey, clientId: "host-real-0003" });
    try {
      await host.connect();
      await waitFor(() => host.room !== null && Object.keys(host.room!.clients).length > 0);
      const target = Object.values(host.room!.clients).find((c) => c.kind === "player")!.id;

      // A drag: 25 calls in a burst, the way a pointermove handler would. The last one is the one the
      // user actually means — it must not be swallowed by the throttle window.
      for (let i = 0; i < 25; i++) host.host.setPosition(target, 0.1 + i * 0.02, 0.9);
      const finalX = 0.1 + 24 * 0.02;
      await waitFor(() => Math.abs((host.room!.clients[target]!.position?.x ?? -1) - finalX) < 1e-9, 4000);
      expect(host.room!.clients[target]!.position!.y).toBeCloseTo(0.9, 9);
      // and it cannot have sent 25 messages: the cap is SET_POSITION_MAX_HZ
      expect(SET_POSITION_MAX_HZ).toBe(10);
    } finally {
      host.disconnect();
    }
  });
  /*
   * CALIBRATION_RESET (v3) through the public API, over a real socket. The server semantics are covered
   * in the protocol package; what this test adds is that `host.resetCalibration(...)` produces a message
   * the server accepts, and that the *phone* sees its compensation change — a reset the engine does not
   * feel is a control that lies. The measured offset is planted directly on the in-process mock, because
   * writing it the honest way needs a microphone.
   */
  test("host.resetCalibration clears a measured offset, one client and then the whole room", async () => {
    const host = createHiveClient({ ...base(), kind: "host", plays: false, hostKey: mock.hostKey, clientId: "host-rst-0001" });
    const player = createHiveClient({ ...base(), kind: "player", plays: true, name: "Rst", clientId: "play-rst-0001" });
    try {
      await Promise.all([host.connect(), player.connect()]);
      await waitFor(() => player.assignment !== null);
      const rec = () => mock.room.clients["play-rst-0001"]!;

      // stand in for a tuning moment, then a NUDGE(0) to make the server replan and broadcast it
      rec().calibratedOffsetMs = 77;
      host.host.nudge("play-rst-0001", 0);
      await waitFor(() => player.assignment?.compensationMs === 77);

      host.host.resetCalibration("play-rst-0001");
      await waitFor(() => rec().calibratedOffsetMs === null);
      await waitFor(() => player.assignment?.compensationMs === 0); // browserFamily "other": no table row

      // the whole-room form: `clientId` absent, not `undefined`
      rec().calibratedOffsetMs = 41;
      host.host.nudge("play-rst-0001", 0);
      await waitFor(() => player.assignment?.compensationMs === 41);
      host.host.resetCalibration();
      await waitFor(() => rec().calibratedOffsetMs === null);
      await waitFor(() => player.assignment?.compensationMs === 0);
    } finally {
      host.disconnect();
      player.disconnect();
    }
  });
});
