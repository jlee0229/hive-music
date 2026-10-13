// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { IDLE_CALIBRATION, PROTOCOL_VERSION, type ClientRecord, type RoomState } from "@hive/protocol";
import { strobeGroupsRow } from "./strobe-groups";

function speaker(i: number, over: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: `player-${String(i).padStart(3, "0")}`, kind: "player", plays: true, name: `P${i}`,
    device: { userAgent: "", platform: "test", browserFamily: "other" },
    joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0,
    tableLatencyMs: null, calibratedOffsetMs: null, assignment: null, connected: true, audioReadyTrackId: "t1",
    ...over,
  };
}

function strobeRoom(clients: ClientRecord[], groups?: number): RoomState {
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t1", title: "T", durationSec: 60, stems: ["mix"], bpm: 120 },
    transport: { state: "stopped" }, mode: { kind: "STROBE", params: groups === undefined ? {} : { groups } }, scenePlan: null,
    calibration: IDLE_CALIBRATION,
    clients: Object.fromEntries(clients.map((c) => [c.id, c])),
  };
}

const many = (n: number) => Array.from({ length: n }, (_, i) => speaker(i + 1));

describe("strobeGroupsRow", () => {
  test("offers only counts the room can fill, and highlights the count actually in rotation", () => {
    expect(strobeGroupsRow(strobeRoom(many(12), 4))).toEqual({ choices: [2, 3, 4, 5, 6, 8], effective: 4 });
    expect(strobeGroupsRow(strobeRoom(many(5), 3))).toEqual({ choices: [2, 3, 4, 5], effective: 3 });
    expect(strobeGroupsRow(strobeRoom(many(2)))).toEqual({ choices: [2], effective: 2 });
  });

  test("8 requested, 5 phones there: the row shows 5 running — and the request itself is not something the row changes", () => {
    const room = strobeRoom(many(5), 8);
    expect(strobeGroupsRow(room)).toEqual({ choices: [2, 3, 4, 5], effective: 5 });
    expect(room.mode.params.groups).toBe(8);
  });

  test("an effective count that is not one of the standard chips (7 phones, 8 requested) still gets a chip to highlight", () => {
    expect(strobeGroupsRow(strobeRoom(many(7), 8))).toEqual({ choices: [2, 3, 4, 5, 6, 7], effective: 7 });
  });

  test("one phone, or none: no row at all", () => {
    expect(strobeGroupsRow(strobeRoom(many(1), 4)).choices).toEqual([]);
    expect(strobeGroupsRow(strobeRoom([], 4)).choices).toEqual([]);
  });

  test("only phones that are there count: disconnected records and a non-playing host do not", () => {
    const clients = [...many(3), speaker(4, { connected: false }), speaker(5, { connected: false }), speaker(0, { kind: "host", plays: false })];
    expect(strobeGroupsRow(strobeRoom(clients, 6))).toEqual({ choices: [2, 3], effective: 3 });
  });
});
