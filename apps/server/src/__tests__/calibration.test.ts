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

describe("calibration (B8s)", () => {
  test("reference gets CALIBRATION_PLAN; players get one SCHEDULED_ACTION each on the 400ms grid; REPORT updates calibratedOffsetMs; low confidence is ignored", () => {
    const { server } = fakeServer();
    const room = new Room("CAL1", server, () => {}, () => []);

    const ref = fakeWs();
    room.join(ref.ws, { type: "JOIN", clientId: "host-cal-ref1", roomCode: "CAL1", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    room.join(p1.ws, { type: "JOIN", clientId: "play-cal-p001", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const p2 = fakeWs();
    room.join(p2.ws, { type: "JOIN", clientId: "play-cal-p002", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const p3 = fakeWs();
    room.join(p3.ws, { type: "JOIN", clientId: "play-cal-p003", roomCode: "CAL1", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });

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
