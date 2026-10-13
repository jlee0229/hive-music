import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { CALIBRATED_OFFSET_MAX_MS, CALIBRATED_OFFSET_MIN_MS, CALIBRATION_MAX_STEP_MS, CALIBRATION_REPORT_GRACE_MS, CALIBRATION_REPORT_GRACE_PER_PHONE_MS, Room, type Conn } from "../rooms";

/**
 * ENGINE-DSP-45 / SCALE-NET-09. A tuning moment gives each phone a 400 ms slot and attributes
 * whatever the reference hears in a slot to that slot's phone. A phone that is very late is heard
 * in its neighbour's slot, and the server used to believe it and add the number to the neighbour's
 * offset — any number, on top of any previous number. And the run was declared failed 5 s after the
 * last click however many phones the reference still had to analyse.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const }; // table guess: 25 ms
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => void sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
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
const id = (i: number) => `phone-cal-${String(i).padStart(4, "0")}`;

function tuning(phones: number) {
  const room = new Room("TUNE", fakeServer(), () => {}, () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"] }]);
  const host = fakeWs();
  room.join(host.ws, join(room, "host-cal-00001", "host"));
  room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
  for (let i = 1; i <= phones; i++) {
    const p = fakeWs();
    room.join(p.ws, join(room, id(i), "player"));
    room.handle(p.ws, { type: "AUDIO_READY", trackId: "t" });
  }
  const start = () => room.handle(host.ws, { type: "CALIBRATION_START", referenceClientId: "host-cal-00001" });
  const report = (measurements: Array<[phone: number, residualMs: number, confidence?: number]>) =>
    room.handle(host.ws, { type: "CALIBRATION_REPORT", measurements: measurements.map(([i, residualMs, confidence = 0.9]) => ({ clientId: id(i), residualMs, confidence })) });
  const offset = (i: number) => room.room.clients[id(i)]!.calibratedOffsetMs;
  return { room, host, start, report, offset };
}

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("ENGINE-DSP-45: a report cannot move a phone to somewhere a phone cannot be", () => {
  test("the misattributed click: phone 1 silent, 'phone 2 is 100 ms early' with confidence 0.89 → not applied, run failed", () => {
    const t = tuning(2);
    t.start();
    t.report([
      [1, 0, 0.1], // phone 1's click was not found in its slot…
      [2, -100, 0.89], // …because it sounded 300 ms late, in phone 2's
    ]);
    expect(t.offset(2)).toBeNull(); // 25 ms of table guess − 100 would be a phone with negative latency
    expect(t.offset(1)).toBeNull();
    expect(t.room.room.calibration.state).toBe("failed");
    expect(t.room.room.calibration.results).toEqual({});
    t.room.destroy();
  });

  test("an honest report with one outlier: the outlier is left alone, the rest are applied", () => {
    const t = tuning(5);
    t.start();
    t.report([
      [1, 12],
      [2, -9],
      [3, 0],
      [4, CALIBRATION_MAX_STEP_MS + 50], // more than half a slot away: that is a neighbour's click
      [5, 31],
    ]);
    expect(t.room.room.calibration.state).toBe("done");
    expect([1, 2, 3, 5].map(t.offset)).toEqual([37, 16, 25, 56]);
    expect(t.offset(4)).toBeNull();
    expect(Object.keys(t.room.room.calibration.results).sort()).toEqual([id(1), id(2), id(3), id(5)]);
    t.room.destroy();
  });

  test("a report that is mostly implausible measured something else: nothing in it is applied", () => {
    const t = tuning(5);
    t.start();
    t.report([
      [1, 8], // plausible on its own
      [2, -150],
      [3, 240],
      [4, -90],
      [5, 10],
    ]);
    expect(t.room.room.calibration.state).toBe("failed");
    expect([1, 2, 3, 4, 5].map(t.offset)).toEqual([null, null, null, null, null]);
    t.room.destroy();
  });

  test("the same phone twice in one report is not a measurement of anything", () => {
    const t = tuning(2);
    t.start();
    t.report([
      [1, 10],
      [1, 30],
      [2, 5],
    ]);
    expect(t.room.room.calibration.state).toBe("failed");
    expect([t.offset(1), t.offset(2)]).toEqual([null, null]);
    t.room.destroy();
  });

  test("offsets accumulate over runs only inside the range real output paths have", () => {
    const t = tuning(2);
    const run = (residual: number) => {
      t.start();
      t.report([
        [1, residual],
        [2, 0],
      ]);
    };
    run(150);
    run(150);
    expect(t.offset(1)).toBe(325); // 25 + 150 + 150: a Bluetooth speaker, plausible
    run(150); // 475 would be past CALIBRATED_OFFSET_MAX_MS
    expect(t.offset(1)).toBe(325);
    expect(t.offset(1)!).toBeLessThanOrEqual(CALIBRATED_OFFSET_MAX_MS);
    expect(t.room.room.calibration.state).toBe("done"); // phone 2's honest 0 still counted

    for (let i = 0; i < 6; i++) run(-150); // walking the other way stops just as firmly
    expect(t.offset(1)!).toBeGreaterThanOrEqual(CALIBRATED_OFFSET_MIN_MS);
    expect(t.offset(1)).toBe(25); // 325 − 150 − 150; the third −150 would be −125
    t.room.destroy();
  });
});

describe("SCALE-NET-09: the report deadline grows with the room", () => {
  test("60 phones: a report that takes 9 s to compute after the last click is accepted; the old fixed 5 s would have failed it", () => {
    const t = tuning(60);
    t.start();
    const lastClick = CALIBRATION_COUNTDOWN_MS + 60 * CALIBRATION_CLICK_INTERVAL_MS;
    jest.advanceTimersByTime(lastClick + 9000);
    expect(t.room.room.calibration.state).toBe("running"); // still waiting for the reference
    t.report(Array.from({ length: 60 }, (_, i) => [i + 1, (i % 7) - 3] as [number, number]));
    expect(t.room.room.calibration.state).toBe("done");
    expect(t.offset(60)).toBe(25 + ((59 % 7) - 3));
    t.room.destroy();
  });

  test("…and a reference that never reports still fails the run, at 5 s + 100 ms per phone after the last click", () => {
    const t = tuning(60);
    t.start();
    const deadline = CALIBRATION_COUNTDOWN_MS + 60 * CALIBRATION_CLICK_INTERVAL_MS + CALIBRATION_REPORT_GRACE_MS + 60 * CALIBRATION_REPORT_GRACE_PER_PHONE_MS;
    expect(deadline - (CALIBRATION_COUNTDOWN_MS + 60 * CALIBRATION_CLICK_INTERVAL_MS)).toBe(11_000);
    jest.advanceTimersByTime(deadline - 200);
    expect(t.room.room.calibration.state).toBe("running");
    jest.advanceTimersByTime(400);
    expect(t.room.room.calibration.state).toBe("failed");
    t.room.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
