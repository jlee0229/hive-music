import { describe, expect, test } from "bun:test";
import { CLIENT_MESSAGE_TYPES, ClientMessageSchema, SERVER_MESSAGE_TYPES, ServerMessageSchema, parseClientMessage, parseServerMessage } from "../messages";
import { RoomStateSchema, IDLE_CALIBRATION } from "../room";
import { ScenePlanSchema, activeSceneIndex } from "../scene";
import { PROTOCOL_VERSION } from "../constants";

const device = { userAgent: "ua", platform: "iPhone", browserFamily: "ios-safari" as const };

describe("message schemas", () => {
  test("every client message type has a parsable example", () => {
    const examples: Record<string, unknown> = {
      JOIN: { type: "JOIN", clientId: "11111111-aaaa", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION },
      NTP_REQUEST: { type: "NTP_REQUEST", t0: 1, probeGroupId: 3, probeGroupIndex: 0 },
      SET_TRACK: { type: "SET_TRACK", trackId: "synthetic-60s" },
      TRANSPORT: { type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 },
      SET_MODE: { type: "SET_MODE", mode: "WAVE", params: { axis: "x", spanMs: 200 } },
      ASSIGN: { type: "ASSIGN", clientId: "x", role: "drums" },
      SET_POSITION: { type: "SET_POSITION", clientId: "x", x: 0.2, y: 0.9 },
      NUDGE: { type: "NUDGE", clientId: "x", nudgeMs: -40 },
      SET_PLAYS: { type: "SET_PLAYS", plays: true },
      KICK: { type: "KICK", clientId: "x" },
      AUDIO_READY: { type: "AUDIO_READY", trackId: "synthetic-60s" },
      CLIENT_STATUS: { type: "CLIENT_STATUS", rttMs: 20, syncErrMs: 4, outputLatencyMs: null, audioState: "ready" },
      CALIBRATION_START: { type: "CALIBRATION_START", referenceClientId: "host-1" },
      CALIBRATION_REPORT: { type: "CALIBRATION_REPORT", measurements: [{ clientId: "x", residualMs: 12.5, confidence: 0.9 }] },
      CALIBRATION_CANCEL: { type: "CALIBRATION_CANCEL" },
      CALIBRATION_RESET: { type: "CALIBRATION_RESET", clientId: "x" },
      PONG: { type: "PONG" },
    };
    for (const t of CLIENT_MESSAGE_TYPES) {
      expect(examples[t], `missing example for ${t}`).toBeDefined();
      const r = ClientMessageSchema.safeParse(examples[t]);
      expect(r.success, `${t}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
    }
    expect(Object.keys(examples).sort()).toEqual([...CLIENT_MESSAGE_TYPES].sort());
  });

  test("every server message type has a parsable example", () => {
    const room = RoomStateSchema.parse({
      code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [], track: null,
      transport: { state: "stopped" }, mode: { kind: "UNISON", params: {} }, scenePlan: null, calibration: IDLE_CALIBRATION, clients: {},
    });
    const click = { kind: "click", burstMs: 2, chirpFromHz: 2000, chirpToHz: 6000, chirpMs: 20, gain: 0.8 };
    const examples: Record<string, unknown> = {
      WELCOME: { type: "WELCOME", clientId: "x", roomCode: "BZQ7", serverTime: 1, protocolVersion: PROTOCOL_VERSION, isHost: false },
      NTP_RESPONSE: { type: "NTP_RESPONSE", t0: 1, t1: 2, t2: 3 },
      ROOM_STATE: { type: "ROOM_STATE", room },
      HEALTH: { type: "HEALTH", serverTime: 1, clients: { x: { rttMs: 1, syncErrMs: 2, outputLatencyMs: null, audioState: "ready", lastSeenServerTime: 1 } } },
      SCHEDULED_ACTION: { type: "SCHEDULED_ACTION", serverTimeToExecute: 5, action: { kind: "CALIBRATION_CLICK", clickId: "c1", clickSpec: click } },
      CALIBRATION_PLAN: { type: "CALIBRATION_PLAN", startServerTime: 5, intervalMs: 400, order: ["a", "b"], clickSpec: click },
      PING: { type: "PING", serverTime: 1 },
      ERROR: { type: "ERROR", code: "NO_ROOM", message: "nope" },
    };
    for (const t of SERVER_MESSAGE_TYPES) {
      const r = ServerMessageSchema.safeParse(examples[t]);
      expect(r.success, `${t}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
    }
    expect(Object.keys(examples).sort()).toEqual([...SERVER_MESSAGE_TYPES].sort());
  });

  test("parseClientMessage rejects garbage and out-of-range values", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage({ type: "NUDGE", clientId: "x", nudgeMs: 500 })).toBeNull();
    expect(parseClientMessage({ type: "SET_POSITION", clientId: "x", x: 1.2, y: 0 })).toBeNull();
  });

  test("docs/02-protocol.md lists exactly the message types in the schemas", async () => {
    const doc = await Bun.file(`${import.meta.dir}/../../../../docs/02-protocol.md`).text();
    const listed = new Set([...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!));
    const expected = new Set<string>([...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES]);
    const missingInDoc = [...expected].filter((t) => !listed.has(t));
    const extraInDoc = [...listed].filter((t) => !expected.has(t));
    expect(missingInDoc, "types in code but not in docs/02-protocol.md").toEqual([]);
    expect(extraInDoc, "types in docs/02-protocol.md but not in code").toEqual([]);
  });
});

describe("PROTO-13 · an old tab survives a newer server", () => {
  const rec = {
    id: "c1-00000000", kind: "player", plays: true, name: "P", device, joinIndex: 1, joinedAtServerTime: 0, position: null, pinnedRole: null,
    nudgeMs: 0, tableLatencyMs: null, calibratedOffsetMs: null, connected: true, audioReadyTrackId: null,
    assignment: { label: "drums", role: "drums", color: "#F59E0B", gainsDb: { mix: 0 }, delayMs: 0, compensationMs: 12, pattern: null, applyAtServerTime: null },
  };
  const base = {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION + 1, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t", title: "T", durationSec: 60, stems: ["mix"], somethingNew: 1 },
    transport: { state: "playing", serverTimeAtTrackZero: 123 }, mode: { kind: "UNISON", params: {} }, scenePlan: null,
    calibration: IDLE_CALIBRATION, clients: { "c1-00000000": rec },
  };
  const wire = (room: unknown) => parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room }));

  test("a mode this bundle has never heard of does not cost it the whole snapshot", () => {
    // what CHOIR was to every tab that predated it: strict parsing dropped every ROOM_STATE while it was on
    const future = { ...base, mode: { kind: "DISCO", params: { sparkle: 9, groups: 64 } } };
    expect(RoomStateSchema.safeParse(future).success).toBe(false); // the strict schema still says no
    const m = wire(future);
    expect(m).not.toBeNull();
    if (m?.type !== "ROOM_STATE") throw new Error("not a ROOM_STATE");
    expect(m.room.mode).toEqual({ kind: "UNISON", params: {} });
    // and what the phone needs to keep playing is intact
    expect(m.room.transport).toEqual({ state: "playing", serverTimeAtTrackZero: 123 });
    expect(m.room.clients["c1-00000000"]!.assignment!.compensationMs).toBe(12);
  });

  test("a scene plan it cannot read becomes no plan; unknown kinds, roles, patterns and devices degrade one field", () => {
    const m = wire({
      ...base,
      scenePlan: { prompt: "p", source: "rules", createdAtServerTime: 0, scenes: [{ atTrackSec: 0, mode: "DISCO", params: {}, note: "n" }] },
      clients: {
        "c1-00000000": { ...rec, kind: "robot", device: { ...device, browserFamily: "vision-pro" }, assignment: { ...rec.assignment, role: "piano", pattern: { kind: "sparkle", periodMs: 5, phaseMs: 0 } } },
      },
    });
    if (m?.type !== "ROOM_STATE") throw new Error("not a ROOM_STATE");
    expect(m.room.scenePlan).toBeNull();
    const c = m.room.clients["c1-00000000"]!;
    expect(c.kind).toBe("viewer");
    expect(c.device.browserFamily).toBe("other");
    expect(c.assignment).toMatchObject({ role: "unison", pattern: null, label: "drums", gainsDb: { mix: 0 } });
  });

  test("what a phone cannot play without stays strict, and everything valid parses exactly as before", () => {
    expect(wire({ ...base, transport: { state: "warp" } })).toBeNull();
    expect(wire({ ...base, clients: { "c1-00000000": { ...rec, assignment: { ...rec.assignment, compensationMs: null } } } })).toBeNull();
    expect(wire({ ...base, track: { id: "t", title: "T", durationSec: -1, stems: [] } })).toBeNull();
    const valid = { ...base, track: { id: "t", title: "T", durationSec: 60, stems: ["mix"] }, mode: { kind: "STROBE", params: { groups: 4, beatsPerSwitch: 0.5 } } };
    const m = wire(valid);
    if (m?.type !== "ROOM_STATE") throw new Error("not a ROOM_STATE");
    expect(m.room).toEqual(RoomStateSchema.parse(valid));
  });
});

describe("scene plan", () => {
  test("requires ascending scenes and finds the active one", () => {
    const ok = ScenePlanSchema.safeParse({ prompt: "p", source: "rules", createdAtServerTime: 0, scenes: [{ atTrackSec: 0, mode: "UNISON", params: {}, note: "a" }, { atTrackSec: 30, mode: "WAVE", params: {}, note: "b" }] });
    expect(ok.success).toBe(true);
    const bad = ScenePlanSchema.safeParse({ prompt: "p", source: "rules", createdAtServerTime: 0, scenes: [{ atTrackSec: 30, mode: "UNISON", params: {}, note: "a" }, { atTrackSec: 10, mode: "WAVE", params: {}, note: "b" }] });
    expect(bad.success).toBe(false);
    if (ok.success) {
      expect(activeSceneIndex(ok.data, 0)).toBe(0);
      expect(activeSceneIndex(ok.data, 29.9)).toBe(0);
      expect(activeSceneIndex(ok.data, 30)).toBe(1);
    }
    expect(activeSceneIndex(null, 10)).toBe(-1);
  });
});
