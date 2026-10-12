/**
 * What one hostile phone with the room code can do to everyone else. Each test drives the mock over a
 * real WebSocket with exactly the bytes an attacker would send; the mock and apps/server share
 * `parseClientMessage`, the planner and the same `room.clients[id]` indexing, so a hole here is a hole
 * in production.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../constants";
import { parseClientMessage } from "../messages";
import { startMockServer } from "../mock-server";
import { Raw, device, sleep, testPort } from "./harness";

const PORT = testPort(5);
let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
  await mock.ready;
});
afterAll(() => mock.stop());

const join = (clientId: string, kind: "host" | "player" = "player", hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode: "BZQ7", kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });

async function hostAndVictim() {
  const host = new Raw(PORT);
  await host.open();
  host.sendRaw(join("host-0000-aaaa", "host", mock.hostKey));
  await host.next("WELCOME");
  const victim = new Raw(PORT);
  await victim.open();
  victim.sendRaw(join(`victim-${Math.random().toString(36).slice(2, 10)}`));
  await victim.next("WELCOME");
  await victim.next("ROOM_STATE");
  return { host, victim };
}

describe("PROTO-01 · a client id that names an Object.prototype key", () => {
  const RESERVED = ["toString", "constructor", "__proto__", "hasOwnProperty", "isPrototypeOf", "toLocaleString", "__defineGetter__"];

  test("is refused by the schema, in JOIN and in every message that names a client", () => {
    for (const id of RESERVED) {
      expect(parseClientMessage(join(id)), `JOIN as ${id}`).toBeNull();
      expect(parseClientMessage({ type: "ASSIGN", clientId: id, role: "drums" }), `ASSIGN ${id}`).toBeNull();
      expect(parseClientMessage({ type: "SET_POSITION", clientId: id, x: 0.5, y: 0.5 }), `SET_POSITION ${id}`).toBeNull();
      expect(parseClientMessage({ type: "NUDGE", clientId: id, nudgeMs: 1 }), `NUDGE ${id}`).toBeNull();
      expect(parseClientMessage({ type: "KICK", clientId: id }), `KICK ${id}`).toBeNull();
      expect(parseClientMessage({ type: "CALIBRATION_START", referenceClientId: id }), `CALIBRATION_START ${id}`).toBeNull();
      expect(parseClientMessage({ type: "CALIBRATION_RESET", clientId: id }), `CALIBRATION_RESET ${id}`).toBeNull();
      expect(parseClientMessage({ type: "CALIBRATION_REPORT", measurements: [{ clientId: id, residualMs: 1, confidence: 1 }] }), `REPORT ${id}`).toBeNull();
    }
    // ordinary ids are untouched: a UUID, the engine's Math.random fallback, a scenario id
    for (const id of ["3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b", "c-k3j9x0q1z8a7", "mock-01-maya"]) {
      expect(parseClientMessage(join(id)), id).not.toBeNull();
    }
  });

  test("one JOIN as `toString` does not poison ROOM_STATE for the rest of the room", async () => {
    const { host, victim } = await hostAndVictim();
    host.forget();
    victim.forget();

    const attacker = new Raw(PORT);
    await attacker.open();
    attacker.sendRaw(join("toString"));
    await attacker.next("ERROR", (m) => m.code === "BAD_MESSAGE");

    // anything that makes the room publish: before the fix every snapshot from here on carried a
    // client record with no id/kind/plays, which every phone's parseServerMessage rejected whole
    host.send({ type: "SET_MODE", mode: "WAVE", params: {} });
    const state = await victim.next("ROOM_STATE", (m) => m.room.mode.kind === "WAVE");
    expect(Object.keys(state.room.clients)).not.toContain("toString");
    await sleep(100);
    expect(victim.unparsable).toEqual([]);
    expect(host.unparsable).toEqual([]);
    expect(Object.keys(mock.room.clients).sort()).toEqual(Object.keys(state.room.clients).sort());
    host.close(); victim.close(); attacker.close();
  });
});

describe("PROTO-02 · 1e999 is valid JSON and parses to Infinity", () => {
  const INF = [
    '{"type":"CLIENT_STATUS","rttMs":1,"syncErrMs":1,"outputLatencyMs":1e999,"audioState":"ready"}',
    '{"type":"CLIENT_STATUS","rttMs":1e999,"syncErrMs":1,"outputLatencyMs":null,"audioState":"ready"}',
    '{"type":"CLIENT_STATUS","rttMs":1,"syncErrMs":-1e999,"outputLatencyMs":null,"audioState":"ready"}',
    '{"type":"TRANSPORT","action":"SEEK","trackTimeSec":1e999}',
    '{"type":"NTP_REQUEST","t0":1e999}',
    '{"type":"CALIBRATION_REPORT","measurements":[{"clientId":"x","residualMs":1e999,"confidence":0.9}]}',
  ];

  test("no client message field accepts a non-finite number", () => {
    for (const raw of INF) expect(parseClientMessage(raw), raw).toBeNull();
    // the finite versions of the same messages still parse
    for (const raw of INF) expect(parseClientMessage(raw.replace(/-?1e999/, "12.5")), raw).not.toBeNull();
  });

  test("an Infinity outputLatency cannot reach calibratedOffsetMs and null out compensationMs for the room", async () => {
    const { host, victim } = await hostAndVictim();
    const attacker = new Raw(PORT);
    await attacker.open();
    // browserFamily "other" has no latency-table row, so the calibration base falls through to the
    // phone's own reported outputLatencyMs — the number under attack
    attacker.sendRaw(JSON.stringify({ type: "JOIN", clientId: "attacker-inf-0001", roomCode: "BZQ7", kind: "player", plays: true, device: { ...device, browserFamily: "other" }, protocolVersion: PROTOCOL_VERSION }));
    await attacker.next("WELCOME");
    attacker.forget();
    attacker.sendRaw(INF[0]!);
    await attacker.next("ERROR", (m) => m.code === "BAD_MESSAGE");

    host.forget();
    victim.forget();
    host.send({ type: "CALIBRATION_START", referenceClientId: "host-0000-aaaa" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "countdown");
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "attacker-inf-0001", residualMs: 3, confidence: 0.9 }] });
    const done = await victim.next("ROOM_STATE", (m) => m.room.calibration.state === "done");
    expect(Number.isFinite(done.room.clients["attacker-inf-0001"]!.assignment!.compensationMs)).toBe(true);
    expect(victim.unparsable).toEqual([]);
    host.send({ type: "CALIBRATION_CANCEL" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");
    host.close(); victim.close(); attacker.close();
  });
});
