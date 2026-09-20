import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, STARTER_LATENCY_TABLE_MS } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "android-chrome" as const };

function fakeServer() {
  const server = { publish: () => {} } as unknown as Bun.Server<Conn>;
  return server;
}
function fakeWs() {
  const ws = { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
  return ws;
}
const fakeLibrary = () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }];

const status = (outputLatencyMs: number | null) =>
  ({ type: "CLIENT_STATUS", rttMs: 10, syncErrMs: 5, outputLatencyMs, audioState: "ready" }) as const;

// replan() swaps in fresh client-record copies, so every assertion re-reads through the room.
const recOf = (room: Room, id: string) => room.room.clients[id]!;

describe("live outputLatency beats the starter table", () => {
  test("a reported outputLatency nulls tableLatencyMs so the phone subtracts its own live value", () => {
    const room = new Room("LAT1", fakeServer(), () => {}, fakeLibrary);
    const p = fakeWs();
    room.join(p, { type: "JOIN", clientId: "play-lat-p001", roomCode: "LAT1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect(recOf(room, "play-lat-p001").tableLatencyMs).toBe(STARTER_LATENCY_TABLE_MS["android-chrome"]);

    room.handle(p, status(52));
    expect(recOf(room, "play-lat-p001").tableLatencyMs).toBeNull();
    // With no table and no calibration, the planner's compensation carries nothing but the nudge.
    expect(recOf(room, "play-lat-p001").assignment?.compensationMs ?? 0).toBe(0);

    room.destroy();
  });

  test("no report, or a zero report, leaves the table guess in place", () => {
    const room = new Room("LAT2", fakeServer(), () => {}, fakeLibrary);
    const p = fakeWs();
    room.join(p, { type: "JOIN", clientId: "play-lat-p002", roomCode: "LAT2", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(p, status(null));
    expect(recOf(room, "play-lat-p002").tableLatencyMs).toBe(STARTER_LATENCY_TABLE_MS["android-chrome"]);
    room.handle(p, status(0));
    expect(recOf(room, "play-lat-p002").tableLatencyMs).toBe(STARTER_LATENCY_TABLE_MS["android-chrome"]);

    room.destroy();
  });

  test("a calibrated phone is never switched back to live latency", () => {
    const room = new Room("LAT3", fakeServer(), () => {}, fakeLibrary);
    const host = fakeWs();
    room.join(host, { type: "JOIN", clientId: "host-lat-ref1", roomCode: "LAT3", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p = fakeWs();
    room.join(p, { type: "JOIN", clientId: "play-lat-p003", roomCode: "LAT3", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(host, { type: "CALIBRATION_START", referenceClientId: "host-lat-ref1" });
    room.handle(host, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-lat-p003", residualMs: 7, confidence: 0.9 }] });
    const calibrated = recOf(room, "play-lat-p003").calibratedOffsetMs;
    expect(calibrated).not.toBeNull();

    room.handle(p, status(52));
    expect(recOf(room, "play-lat-p003").calibratedOffsetMs).toBe(calibrated);
    // The switch must not fire once calibrated: calibratedOffsetMs stays authoritative.
    expect(recOf(room, "play-lat-p003").tableLatencyMs).not.toBeNull();

    room.destroy();
  });

  test("calibration after the switch accumulates onto the reported live latency, not 0", () => {
    const room = new Room("LAT4", fakeServer(), () => {}, fakeLibrary);
    const host = fakeWs();
    room.join(host, { type: "JOIN", clientId: "host-lat-ref2", roomCode: "LAT4", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p = fakeWs();
    room.join(p, { type: "JOIN", clientId: "play-lat-p004", roomCode: "LAT4", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(p, status(52)); // table gone; phone now subtracts 52 ms locally
    room.handle(host, { type: "CALIBRATION_START", referenceClientId: "host-lat-ref2" });
    room.handle(host, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-lat-p004", residualMs: 7, confidence: 0.9 }] });

    // base = calibrated ?? table ?? health.outputLatencyMs: the 52 the phone was already applying.
    expect(recOf(room, "play-lat-p004").calibratedOffsetMs).toBe(52 + 7);

    room.destroy();
  });
});
