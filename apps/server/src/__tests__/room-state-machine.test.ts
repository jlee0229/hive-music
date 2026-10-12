import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { DISCONNECT_RETENTION_MS, PROTOCOL_VERSION, type ClientMessage, type ScenePlan, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/** Audit SG-10: small state-machine holes in the room, each with the party scenario that hits it. */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const library = () => [
  { id: "song-a", title: "A", durationSec: 200, stems: ["mix"], urls: {} },
  { id: "song-b", title: "B", durationSec: 90, stems: ["mix"], urls: {} },
];
const join = (room: Room, clientId: string, kind: "host" | "player"): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: room.code,
  kind,
  plays: kind === "player",
  hostKey: kind === "host" ? room.hostKey : undefined,
  device,
  protocolVersion: PROTOCOL_VERSION,
});
const planFor = (prompt: string): ScenePlan => ({
  prompt,
  source: "rules",
  createdAtServerTime: 0,
  scenes: [
    { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
    { atTrackSec: 30, mode: "STROBE", params: {}, note: "drop" },
  ],
});
function party(code: string) {
  const room = new Room(code, fakeServer(), () => {}, library);
  const host = fakeWs();
  const guest = fakeWs();
  room.join(host.ws, join(room, "host-sm-00001", "host"));
  room.join(guest.ws, join(room, "play-sm-00001", "player"));
  room.handle(host.ws, { type: "SET_TRACK", trackId: "song-a" });
  return { room, host, guest };
}

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("SG-10: a vibe plan belongs to one song", () => {
  test("switching songs by hand drops the old song's plan (it used to drive the new song's modes)", () => {
    const { room, host } = party("SM01");
    expect(room.acceptScenePlan(planFor("for song A"))).toBe(true);
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    expect(room.room.scenePlan?.prompt).toBe("for song A");

    room.handle(host.ws, { type: "SET_TRACK", trackId: "song-b" }); // the old plan would flip it to STROBE 30 s in
    expect(room.room.scenePlan).toBeNull();
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    jest.advanceTimersByTime(60_000);
    expect(room.room.mode.kind).toBe("UNISON");
    expect(room.room.track?.id).toBe("song-b");
    room.destroy();
  });

  test("re-selecting the same song keeps its plan", () => {
    const { room, host } = party("SM02");
    room.acceptScenePlan(planFor("for song A"));
    room.handle(host.ws, { type: "SET_TRACK", trackId: "song-a" });
    expect(room.room.scenePlan?.prompt).toBe("for song A");
    room.destroy();
  });

  test("a plan still being written when the song changes (by hand or by the playlist) is dropped when it lands", () => {
    const { room, host } = party("SM03");
    const inFlight = room.getModeVersion(); // the vibe route snapshots this before its LLM call
    room.handle(host.ws, { type: "SET_TRACK", trackId: "song-b" });
    expect(room.acceptScenePlan(planFor("late, for song A"), inFlight)).toBe(false);
    expect(room.room.scenePlan).toBeNull();

    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    const duringB = room.getModeVersion();
    jest.advanceTimersByTime(90_000); // song B ends → the playlist advances to song A
    expect(room.room.track?.id).toBe("song-a");
    expect(room.acceptScenePlan(planFor("late, for song B"), duringB)).toBe(false);
    room.destroy();
  });

  test("a plan that lands after the room was destroyed arms nothing", () => {
    const { room, host } = party("SM04");
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    room.destroy();
    expect(jest.getTimerCount()).toBe(0);
    expect(room.acceptScenePlan(planFor("too late"))).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("SG-10: calibration", () => {
  const ready = (p: ReturnType<typeof party>) => p.room.handle(p.guest.ws, { type: "AUDIO_READY", trackId: "song-a" });
  const report: ClientMessage = { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-sm-00001", residualMs: 12, confidence: 0.9 }] };

  test("a duplicate CALIBRATION_REPORT for the same run is not applied twice", () => {
    const p = party("SM05");
    ready(p);
    p.room.handle(p.host.ws, { type: "CALIBRATION_START", referenceClientId: "host-sm-00001" });
    p.room.handle(p.host.ws, report);
    expect(p.room.room.calibration.state).toBe("done");
    expect(p.room.room.clients["play-sm-00001"]!.calibratedOffsetMs).toBe(25 + 12); // desktop-chrome table guess + residual

    p.room.handle(p.host.ws, report);
    p.room.handle(p.host.ws, report);
    expect(p.room.room.clients["play-sm-00001"]!.calibratedOffsetMs).toBe(25 + 12);

    // a NEW run accumulates, as designed
    p.room.handle(p.host.ws, { type: "CALIBRATION_START", referenceClientId: "host-sm-00001" });
    p.room.handle(p.host.ws, report);
    expect(p.room.room.clients["play-sm-00001"]!.calibratedOffsetMs).toBe(25 + 12 + 12);
    p.room.destroy();
  });

  test("CALIBRATION_START with a reference that is not a connected client is refused instead of running into dead air", () => {
    const p = party("SM06");
    ready(p);
    p.room.handle(p.host.ws, { type: "CALIBRATION_START", referenceClientId: "nobody-000001" });
    expect(p.room.room.calibration.state).toBe("idle");
    expect(p.host.sent.at(-1)).toMatchObject({ type: "ERROR", code: "NO_CLIENT" });
    expect(p.guest.sent.some((m) => m.type === "SCHEDULED_ACTION")).toBe(false);

    p.room.disconnect(p.guest.ws); // retained, but not here
    p.room.handle(p.host.ws, { type: "CALIBRATION_START", referenceClientId: "play-sm-00001" });
    expect(p.room.room.calibration.state).toBe("idle");
    p.room.destroy();
  });
});

describe("SG-10: per-client bookkeeping ends with the client", () => {
  test("health entries are removed when a record expires or is kicked", () => {
    const { room, host } = party("SM07");
    const health = room.health;
    for (let i = 0; i < 50; i++) {
      const s = fakeWs();
      room.join(s.ws, join(room, `churn-${String(i).padStart(6, "0")}`, "player"));
      room.disconnect(s.ws);
    }
    expect(health.size).toBe(52);
    jest.advanceTimersByTime(DISCONNECT_RETENTION_MS + 1000);
    expect(Object.keys(room.room.clients).sort()).toEqual(["host-sm-00001", "play-sm-00001"]);
    expect([...health.keys()].sort()).toEqual(["host-sm-00001", "play-sm-00001"]);

    room.handle(host.ws, { type: "KICK", clientId: "play-sm-00001" });
    expect([...health.keys()]).toEqual(["host-sm-00001"]);
    room.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
