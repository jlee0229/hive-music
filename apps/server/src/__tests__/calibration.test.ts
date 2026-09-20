import { describe, expect, test } from "bun:test";
import { CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, PROTOCOL_VERSION, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

function fakeServer() {
  const published: ServerMessage[] = [];
  const server = { publish: (_topic: string, data: string) => published.push(JSON.parse(data)) } as unknown as Bun.Server<Conn>;
  return { server, published };
}
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const fakeLibrary = () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }];
/** Marks a client as having decoded the current track's stems — startCalibration's order requires this. */
function markReady(room: Room, ws: WS, trackId: string) {
  room.handle(ws, { type: "AUDIO_READY", trackId });
}

describe("calibration (B8s)", () => {
  test("reference gets CALIBRATION_PLAN; players get one SCHEDULED_ACTION each on the 400ms grid; REPORT updates calibratedOffsetMs; low confidence is ignored", () => {
    const { server } = fakeServer();
    const room = new Room("CAL1", server, () => {}, fakeLibrary);

    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref1", roomCode: "CAL1", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cal-p001", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const p2 = fakeWs();
    room.join(p2.ws, { type: "JOIN", clientId: "play-cal-p002", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const p3 = fakeWs();
    room.join(p3.ws, { type: "JOIN", clientId: "play-cal-p003", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(ref.ws, { type: "SET_TRACK", trackId: "t" });
    [p1, p2, p3].forEach((p) => markReady(room, p.ws, "t"));

    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref1" });

    expect(room.room.calibration.state).toBe("countdown");
    expect(room.room.calibration.order).toEqual(["play-cal-p001", "play-cal-p002", "play-cal-p003"]);

    const plan = ref.sent.find((m) => m.type === "CALIBRATION_PLAN");
    expect(plan).toBeDefined();
    if (plan?.type === "CALIBRATION_PLAN") {
      expect(plan.intervalMs).toBe(CALIBRATION_CLICK_INTERVAL_MS);
      expect(plan.order).toEqual(["play-cal-p001", "play-cal-p002", "play-cal-p003"]);
      expect(plan.startServerTime).toBe(room.room.calibration.startServerTime!);
    }

    [p1, p2, p3].forEach((p, i) => {
      const clicks = p.sent.filter((m) => m.type === "SCHEDULED_ACTION");
      expect(clicks).toHaveLength(1);
      const click = clicks[0]!;
      if (click.type === "SCHEDULED_ACTION") {
        expect(click.action.kind).toBe("CALIBRATION_CLICK");
        expect(click.serverTimeToExecute).toBe(room.room.calibration.startServerTime! + i * CALIBRATION_CLICK_INTERVAL_MS);
      }
    });

    room.handle(ref.ws, {
      type: "CALIBRATION_REPORT",
      measurements: [
        { clientId: "play-cal-p001", residualMs: 12, confidence: 0.9 },
        { clientId: "play-cal-p002", residualMs: -5, confidence: 0.3 }, // below 0.5: ignored
        { clientId: "play-cal-p003", residualMs: 8, confidence: 0.7 },
      ],
    });

    expect(room.room.calibration.state).toBe("done");
    expect(room.room.clients["play-cal-p001"]!.calibratedOffsetMs).toBe((room.room.clients["play-cal-p001"]!.tableLatencyMs ?? 0) + 12);
    expect(room.room.clients["play-cal-p002"]!.calibratedOffsetMs).toBeNull(); // ignored: confidence < 0.5
    expect(room.room.clients["play-cal-p003"]!.calibratedOffsetMs).toBe((room.room.clients["play-cal-p003"]!.tableLatencyMs ?? 0) + 8);
    expect(room.room.calibration.results["play-cal-p001"]).toEqual({ residualMs: 12, confidence: 0.9 });
    expect(room.room.calibration.results["play-cal-p002"]).toBeUndefined();

    room.destroy();
  });

  test("accumulates onto a previous calibratedOffsetMs across rounds", () => {
    const { server } = fakeServer();
    const room = new Room("CAL2", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref2", roomCode: "CAL2", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cal-r001", roomCode: "CAL2", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref2" });
    room.handle(ref.ws, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cal-r001", residualMs: 10, confidence: 0.9 }] });
    const afterFirst = room.room.clients["play-cal-r001"]!.calibratedOffsetMs!;

    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref2" });
    room.handle(ref.ws, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cal-r001", residualMs: -3, confidence: 0.9 }] });
    expect(room.room.clients["play-cal-r001"]!.calibratedOffsetMs).toBe(afterFirst - 3);

    room.destroy();
  });

  test('falls back to the client\'s own reported outputLatencyMs, not 0, when there is no table entry (browserFamily "other")', () => {
    const { server } = fakeServer();
    const room = new Room("CAL5", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref5", roomCode: "CAL5", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    const otherDevice = { ...device, browserFamily: "other" as const };
    room.join(p1.ws, { type: "JOIN", clientId: "play-cal-other1", roomCode: "CAL5", kind: "player", plays: true, device: otherDevice, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["play-cal-other1"]!.tableLatencyMs).toBeNull(); // STARTER_LATENCY_TABLE_MS.other

    // before any calibration, the client itself was subtracting this locally (docs/02-protocol.md §1)
    room.handle(p1.ws, { type: "CLIENT_STATUS", rttMs: 20, syncErrMs: null, outputLatencyMs: 30, audioState: "ready" });
    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref5" });
    room.handle(ref.ws, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cal-other1", residualMs: 0, confidence: 0.9 }] });

    // a residual of 0 with no fallback would have left calibratedOffsetMs at 0, silently dropping the
    // compensation the client used to apply itself and leaving the phone late by its outputLatency
    expect(room.room.clients["play-cal-other1"]!.calibratedOffsetMs).toBe(30);

    room.destroy();
  });

  test("a report from someone other than the reference is ignored", () => {
    const { server } = fakeServer();
    const room = new Room("CAL3", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref3", roomCode: "CAL3", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cal-x001", roomCode: "CAL3", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref3" });
    // p1 (not the reference) tries to report on itself
    room.handle(p1.ws, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cal-x001", residualMs: 99, confidence: 0.9 }] });

    expect(room.room.calibration.state).toBe("countdown");
    expect(room.room.clients["play-cal-x001"]!.calibratedOffsetMs).toBeNull();

    room.destroy();
  });

  test("marks the round failed if no report arrives in time", async () => {
    const { server } = fakeServer();
    const room = new Room("CAL4", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref4", roomCode: "CAL4", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });

    // no players → order is empty → failure fires at CALIBRATION_COUNTDOWN_MS + 0*interval + 5000
    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-ref4" });
    expect(room.room.calibration.state).toBe("countdown");

    await new Promise((r) => setTimeout(r, CALIBRATION_COUNTDOWN_MS + 5200));
    expect(room.room.calibration.state).toBe("failed");

    room.destroy();
  }, 12000);
});

describe("CALIBRATION_CANCEL (protocol v2)", () => {
  test("returns the room to idle, stops the countdown, and refuses a late report", async () => {
    const { server } = fakeServer();
    const room = new Room("CANCEL1", server, () => {}, fakeLibrary);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cancel-01", roomCode: "CANCEL1", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cancel-01", roomCode: "CANCEL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(ref.ws, { type: "SET_TRACK", trackId: "t" });
    markReady(room, p1.ws, "t");

    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cancel-01" });
    expect(room.room.calibration.state).toBe("countdown");
    expect(room.room.calibration.order).toEqual(["play-cancel-01"]);
    // the player really was told to click, which is why cancelling has to be client-side too
    expect(p1.sent.some((m) => m.type === "SCHEDULED_ACTION" && m.action.kind === "CALIBRATION_CLICK")).toBe(true);

    room.handle(ref.ws, { type: "CALIBRATION_CANCEL" });
    expect(room.room.calibration.state).toBe("idle");
    expect(room.room.calibration.referenceClientId).toBeNull();
    expect(room.room.calibration.order).toEqual([]);
    expect(room.room.calibration.results).toEqual({});

    // a report that was already in flight must not write calibratedOffsetMs
    room.handle(ref.ws, { type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cancel-01", residualMs: 25, confidence: 0.95 }] });
    expect(room.room.clients["play-cancel-01"]!.calibratedOffsetMs).toBeNull();
    expect(room.room.calibration.state).toBe("idle");

    // and the cancelled countdown never advances to running or failed
    await new Promise((r) => setTimeout(r, CALIBRATION_COUNTDOWN_MS + 100));
    expect(room.room.calibration.state).toBe("idle");

    room.destroy();
  }, 6000);

  test("a player cannot cancel", () => {
    const { server } = fakeServer();
    const room = new Room("CANCEL2", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cancel-02", roomCode: "CANCEL2", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cancel-02", roomCode: "CANCEL2", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(ref.ws, { type: "CALIBRATION_START", referenceClientId: "host-cancel-02" });

    room.handle(p1.ws, { type: "CALIBRATION_CANCEL" });
    expect(p1.sent.some((m) => m.type === "ERROR" && m.code === "NOT_HOST")).toBe(true);
    expect(room.room.calibration.state).toBe("countdown"); // unaffected

    room.destroy();
  });

  test("cancelling when nothing is running is harmless", () => {
    const { server } = fakeServer();
    const room = new Room("CANCEL3", server, () => {}, () => []);
    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cancel-03", roomCode: "CANCEL3", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });

    expect(room.room.calibration.state).toBe("idle");
    room.handle(ref.ws, { type: "CALIBRATION_CANCEL" });
    expect(room.room.calibration.state).toBe("idle");

    room.destroy();
  });
});
