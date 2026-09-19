import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { ClockModel, createStubClient } from "../index";

const PORT = 19080 + Math.floor(Math.random() * 900);
let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [{ name: "Mock", browserFamily: "other", position: [0.5, 0.5], health: "good", pinnedRole: null }] } });
  await mock.ready;
});
afterAll(() => mock.stop());

describe("ClockModel", () => {
  test("recovers an injected offset through asymmetric jitter with 20% spikes (min-RTT selection)", () => {
    const m = new ClockModel();
    const TRUE_OFFSET = 137;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 30; i++) {
      const t0 = 1000 + i * 1000;
      const up = 15 + rnd() * 30 + (rnd() < 0.2 ? 80 : 0);
      const down = 15 + rnd() * 30 + (rnd() < 0.2 ? 80 : 0);
      const t1 = t0 + up + TRUE_OFFSET;
      const t2 = t1 + 0.2;
      const t3 = t2 - TRUE_OFFSET + down;
      m.addProbe(t0, t1, t2, t3);
    }
    expect(Math.abs(m.offsetMs! - TRUE_OFFSET)).toBeLessThan(2);
  });
});

describe("createStubClient against the mock", () => {
  test("host and player join, sync, play, and see assignments", async () => {
    const base = { wsUrl: `ws://localhost:${PORT}/ws`, apiUrl: `http://localhost:${PORT}`, roomCode: "BZQ7" };
    const host = createStubClient({ ...base, kind: "host", plays: false, hostKey: mock.hostKey, clientId: "host-stub-0001" });
    const player = createStubClient({ ...base, kind: "player", plays: true, name: "Stub", clientId: "play-stub-0001" });
    await Promise.all([host.connect(), player.connect()]);
    expect(host.connection).toBe("open");

    await new Promise((r) => setTimeout(r, 700)); // a few probes
    expect(player.status.rttMs).not.toBeNull();
    expect(Math.abs(player.status.clockOffsetMs!)).toBeLessThan(50); // same machine

    await player.audio.unlock();
    expect(player.audio.state).toBe("ready");

    host.host.setMode("ORCHESTRA");
    await new Promise<void>((r) => host.on("state", (room) => room.mode.kind === "ORCHESTRA" && r()));
    host.host.play(0);
    await new Promise<void>((r) => player.on("state", (room) => room.transport.state === "playing" && r()));
    await new Promise((r) => setTimeout(r, 700));
    expect(player.clock.trackTimeSec()).toBeGreaterThan(0);
    expect(player.assignment).not.toBeNull();
    expect(host.assignment).toBeNull();

    const plan = await host.host.vibe("calm then explode");
    expect(plan.scenes.length).toBeGreaterThanOrEqual(2);

    host.disconnect();
    player.disconnect();
  });
});
