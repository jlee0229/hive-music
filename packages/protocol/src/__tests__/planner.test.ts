import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ROLE_COLORS, STEMS } from "../constants";
import { compensationMs, plan, SILENT_DB, withAssignments } from "../planner";
import { IDLE_CALIBRATION, type ClientRecord, type RoomState } from "../room";

function client(i: number, over: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: `c${i}-00000000`, kind: "player", plays: true, name: `P${i}`,
    device: { userAgent: "ua", platform: "x", browserFamily: "other" },
    joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0,
    tableLatencyMs: null, calibratedOffsetMs: null, assignment: null, connected: true, audioReadyTrackId: null,
    ...over,
  };
}
function room(clients: ClientRecord[], mode: RoomState["mode"] = { kind: "UNISON", params: {} }, stems: string[] = [...STEMS]): RoomState {
  const rec: RoomState["clients"] = {};
  for (const c of clients) rec[c.id] = c;
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t", title: "t", durationSec: 60, stems }, transport: { state: "stopped" }, mode, scenePlan: null,
    calibration: IDLE_CALIBRATION, clients: rec,
  };
}
const audible = (g: Record<string, number>) => Object.entries(g).filter(([, db]) => db > SILENT_DB).map(([s]) => s).sort();

describe("planner", () => {
  test("UNISON: every speaker plays every stem at 0 dB", () => {
    const a = plan(room([client(0), client(1)]));
    for (const v of Object.values(a)) {
      expect(v).not.toBeNull();
      expect(Object.values(v!.gainsDb).every((db) => db === 0)).toBe(true);
      expect(v!.role).toBe("unison");
    }
  });

  test("ORCHESTRA covers every stem and is stable when someone joins", () => {
    const four = [client(0), client(1), client(2), client(3)];
    const before = plan(room(four, { kind: "ORCHESTRA", params: {} }));
    expect(new Set(Object.values(before).map((v) => v!.label))).toEqual(new Set(STEMS));
    const after = plan(room([...four, client(4)], { kind: "ORCHESTRA", params: {} }));
    for (const c of four) expect(after[c.id]!.label).toBe(before[c.id]!.label);
    expect(after[client(4).id]!.label).toBe("drums"); // 4 % 4
  });

  test("pins win and are honoured across replans", () => {
    const r = room([client(0, { pinnedRole: "vocals" }), client(1)], { kind: "ORCHESTRA", params: {} });
    expect(plan(r)["c0-00000000"]!.label).toBe("vocals");
    expect(plan(r)["c0-00000000"]!.color).toBe(ROLE_COLORS.vocals);
  });

  test("non-playing hosts get no assignment; opted-in hosts do", () => {
    const a = plan(room([client(0, { kind: "host", plays: false }), client(1, { kind: "host", plays: true })]));
    expect(a["c0-00000000"]).toBeNull();
    expect(a["c1-00000000"]).not.toBeNull();
  });

  test("CHOIR rotates pitch steps by joinIndex, full mix audible, timeline untouched", () => {
    const five = [client(0), client(1), client(2), client(3), client(4)];
    const a = plan(room(five, { kind: "CHOIR", params: {} }));
    expect(Object.values(a).map((v) => v!.pitchSemitones)).toEqual([0, 12, -12, 7, 0]); // wraps at 4
    expect(Object.values(a).map((v) => v!.label)).toEqual(["choir", "soprano", "basso", "tenor", "choir"]);
    for (const v of Object.values(a)) {
      expect(audible(v!.gainsDb)).toEqual([...STEMS].sort()); // everyone plays the whole mix
      expect(v!.delayMs).toBe(0); // pitch is a client-side render, never a schedule change
      expect(v!.pattern).toBeNull();
    }
  });

  test("STROBE locks to the track's tempo: period = beats × groups, duty = 1/groups, staggered phases", () => {
    const four = [client(0), client(1), client(2), client(3)];
    const r = room(four, { kind: "STROBE", params: { groups: 4, beatsPerSwitch: 1 } });
    r.track = { ...r.track!, bpm: 120 }; // one beat = 500 ms
    const a = plan(r);
    for (const [i, v] of Object.values(a).entries()) {
      expect(v!.pattern).toMatchObject({ kind: "strobe", periodMs: 2000, duty: 0.25 });
      expect(v!.pattern!.phaseMs).toBe(i * 500); // each group takes exactly one beat, back to back
    }
  });

  test("STROBE anchors to the beat grid: beatOffsetSec shifts every phase onto the drum hits", () => {
    const r = room([client(0), client(1)], { kind: "STROBE", params: { groups: 2, beatsPerSwitch: 1 } });
    r.track = { ...r.track!, bpm: 120, beatOffsetSec: 0.25 }; // first beat 250 ms into the song
    const a = plan(r);
    expect(Object.values(a).map((v) => v!.pattern!.phaseMs)).toEqual([250, 750]);
  });

  test("STROBE without a bpm keeps the free-running period param", () => {
    const r = room([client(0)], { kind: "STROBE", params: { periodMs: 700, duty: 0.5 } });
    r.track = { ...r.track!, bpm: undefined };
    const a = plan(r);
    expect(a["c0-00000000"]!.pattern).toMatchObject({ periodMs: 700, duty: 0.5 });
  });

  test("STEREO splits by position with drums+bass left, vocals+other right", () => {
    const a = plan(room([client(0, { position: { x: 0.1, y: 0.5 } }), client(1, { position: { x: 0.9, y: 0.5 } })], { kind: "STEREO", params: {} }));
    expect(audible(a["c0-00000000"]!.gainsDb)).toEqual(["bass", "drums"]);
    expect(audible(a["c1-00000000"]!.gainsDb)).toEqual(["other", "vocals"]);
  });

  test("WAVE delay grows along the axis up to spanMs and carries a wave pattern", () => {
    const a = plan(room([client(0, { position: { x: 0, y: 0 } }), client(1, { position: { x: 1, y: 0 } }), client(2)], { kind: "WAVE", params: { axis: "x", spanMs: 300 } }));
    expect(a["c0-00000000"]!.delayMs).toBe(0);
    expect(a["c1-00000000"]!.delayMs).toBe(300);
    expect(a["c2-00000000"]!.delayMs).toBe(150); // unplaced → middle
    expect(a["c1-00000000"]!.pattern?.kind).toBe("wave");
  });

  test("STROBE phases groups evenly", () => {
    const a = plan(room([client(0), client(1), client(2), client(3)], { kind: "STROBE", params: { groups: 4, periodMs: 800 } }));
    expect([0, 1, 2, 3].map((i) => a[`c${i}-00000000`]!.pattern!.phaseMs)).toEqual([0, 200, 400, 600]);
  });

  test("mix-only tracks collapse ORCHESTRA to unison", () => {
    const a = plan(room([client(0)], { kind: "ORCHESTRA", params: {} }, ["mix"]));
    expect(a["c0-00000000"]!.gainsDb).toEqual({ mix: 0 });
  });

  test("compensation = nudge + (calibrated ?? table ?? 0) and rides in the assignment", () => {
    expect(compensationMs({ nudgeMs: 5, calibratedOffsetMs: null, tableLatencyMs: 60 })).toBe(65);
    expect(compensationMs({ nudgeMs: -5, calibratedOffsetMs: 40, tableLatencyMs: 60 })).toBe(35);
    const r = withAssignments(room([client(0, { nudgeMs: 12, tableLatencyMs: 45 })]));
    expect(r.clients["c0-00000000"]!.assignment!.compensationMs).toBe(57);
  });

  test("deterministic: same room → identical output", () => {
    const r = room([client(0), client(1), client(2)], { kind: "STROBE", params: {} });
    expect(JSON.stringify(plan(r))).toBe(JSON.stringify(plan(r)));
  });
});
