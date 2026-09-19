import { describe, expect, test } from "bun:test";
import { LEAD_MS, PROTOCOL_VERSION, type ScenePlan, type ServerMessage, type Transport } from "@hive/protocol";
import { currentScene, nextScene } from "../scene-timer";
import { Room, type Conn } from "../rooms";

type WS = Bun.ServerWebSocket<Conn>;

const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

// ---- pure functions (fake clock: serverNow is an explicit parameter, no real timers) -----------------
describe("scene-timer pure functions", () => {
  const zero = 1_000_000; // arbitrary server-time origin
  const transport: Transport = { state: "playing", serverTimeAtTrackZero: zero };
  const plan: ScenePlan = {
    prompt: "test",
    source: "rules",
    createdAtServerTime: 0,
    scenes: [
      { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
      { atTrackSec: 10, mode: "ORCHESTRA", params: {}, note: "build" },
      { atTrackSec: 20, mode: "WAVE", params: { axis: "x", spanMs: 240 }, note: "drop" },
    ],
  };

  test("nextScene finds the next boundary and fires LEAD_MS early", () => {
    const armed = nextScene(plan, transport, zero + 3000); // 3s in, before the 10s boundary
    expect(armed).not.toBeNull();
    expect(armed!.scene.mode).toBe("ORCHESTRA");
    expect(armed!.boundaryServerTime).toBe(zero + 10_000);
    expect(armed!.fireAtServerTime).toBe(zero + 10_000 - LEAD_MS);
  });

  test("nextScene returns the following scene once the first boundary has passed", () => {
    const armed = nextScene(plan, transport, zero + 11_000);
    expect(armed!.scene.mode).toBe("WAVE");
    expect(armed!.boundaryServerTime).toBe(zero + 20_000);
  });

  test("nextScene is null once every boundary has passed, or when not playing", () => {
    expect(nextScene(plan, transport, zero + 25_000)).toBeNull();
    expect(nextScene(plan, { state: "paused", trackTimeAtPause: 5 }, zero)).toBeNull();
    expect(nextScene(plan, { state: "stopped" }, zero)).toBeNull();
    expect(nextScene(null, transport, zero)).toBeNull();
  });

  test("currentScene is null before the first scene's atTrackSec", () => {
    const latePlan: ScenePlan = { ...plan, scenes: [{ atTrackSec: 5, mode: "UNISON", params: {}, note: "open" }, ...plan.scenes.slice(1)] };
    expect(currentScene(latePlan, transport, zero + 1000)).toBeNull(); // 1s in, first scene starts at 5s
    expect(currentScene(latePlan, transport, zero + 6000)!.mode).toBe("UNISON");
  });

  test("currentScene updates at each boundary", () => {
    expect(currentScene(plan, transport, zero)!.mode).toBe("UNISON");
    expect(currentScene(plan, transport, zero + 9999)!.mode).toBe("UNISON");
    expect(currentScene(plan, transport, zero + 15_000)!.mode).toBe("ORCHESTRA");
    expect(currentScene(plan, transport, zero + 25_000)!.mode).toBe("WAVE");
  });
});

// ---- Room integration: real setTimeout wiring, short boundaries so the test stays fast ----------------
describe("scene timer wiring (Room)", () => {
  function fakeServer() {
    const published: ServerMessage[] = [];
    const server = { publish: (_topic: string, data: string) => published.push(JSON.parse(data)) } as unknown as Bun.Server<Conn>;
    return { server, published };
  }
  function fakeWs(): WS {
    return { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
  }
  const roomStates = (published: ServerMessage[]) => published.filter((m): m is Extract<ServerMessage, { type: "ROOM_STATE" }> => m.type === "ROOM_STATE");

  test("a 3-scene plan re-plans at each boundary with applyAtServerTime = boundary", async () => {
    const { server, published } = fakeServer();
    const room = new Room("TEST", server, () => {}, () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }]);

    const hostWs = fakeWs();
    room.join(hostWs, { type: "JOIN", clientId: "host-scene-001", roomCode: "TEST", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const playerWs = fakeWs();
    room.join(playerWs, { type: "JOIN", clientId: "play-scene-001", roomCode: "TEST", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(hostWs, { type: "SET_TRACK", trackId: "t" });
    room.handle(hostWs, { type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    const transportAfterPlay = room.room.transport;
    if (transportAfterPlay.state !== "playing") throw new Error("expected playing transport");
    const zeroTime = transportAfterPlay.serverTimeAtTrackZero;

    const plan: ScenePlan = {
      prompt: "test",
      source: "rules",
      createdAtServerTime: performance.timeOrigin + performance.now(),
      scenes: [
        { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
        { atTrackSec: 1, mode: "ORCHESTRA", params: {}, note: "build" },
        { atTrackSec: 2, mode: "WAVE", params: { axis: "x", spanMs: 240 }, note: "drop" },
      ],
    };
    room.acceptScenePlan(plan);

    await new Promise((r) => setTimeout(r, 2600)); // both the 1s and 2s boundaries should have fired by now

    const modesSeen = roomStates(published).map((m) => m.room.mode.kind);
    expect(modesSeen).toContain("ORCHESTRA");
    expect(modesSeen).toContain("WAVE");

    const orchestraState = roomStates(published).find((m) => m.room.mode.kind === "ORCHESTRA");
    expect(orchestraState!.room.clients["play-scene-001"]!.assignment!.applyAtServerTime).toBe(zeroTime + 1000);

    const waveState = roomStates(published).find((m) => m.room.mode.kind === "WAVE");
    expect(waveState!.room.clients["play-scene-001"]!.assignment!.applyAtServerTime).toBe(zeroTime + 2000);

    room.destroy();
  }, 4000);

  test("SET_MODE (manual override) clears the plan and cancels the timer", async () => {
    const { server, published } = fakeServer();
    const room = new Room("TEST2", server, () => {}, () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }]);
    const hostWs = fakeWs();
    room.join(hostWs, { type: "JOIN", clientId: "host-scene-002", roomCode: "TEST2", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(hostWs, { type: "SET_TRACK", trackId: "t" });
    room.handle(hostWs, { type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });

    room.acceptScenePlan({
      prompt: "test",
      source: "rules",
      createdAtServerTime: performance.timeOrigin + performance.now(),
      scenes: [
        { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
        { atTrackSec: 1, mode: "STROBE", params: {}, note: "drop" },
      ],
    });
    expect(room.room.scenePlan).not.toBeNull();

    room.handle(hostWs, { type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    expect(room.room.scenePlan).toBeNull();

    await new Promise((r) => setTimeout(r, 1600)); // past the cancelled boundary
    const modesSeen = roomStates(published).map((m) => m.room.mode.kind);
    expect(modesSeen).not.toContain("STROBE");

    room.destroy();
  }, 3000);
});
