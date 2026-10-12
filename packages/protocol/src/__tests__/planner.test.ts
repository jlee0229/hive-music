import { describe, expect, test } from "bun:test";
import { ROLE_COLORS, STEMS } from "../constants";
import { speakerLayout } from "../layout";
import { compensationMs, plan, SILENT_DB, withAssignments } from "../planner";
import { prng } from "./harness";
import { client, room } from "./room-fixture";

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

  test("CHOIR always has a root: no lone fifth, no lone octave (PROTO-10)", () => {
    const CHOIR = { kind: "CHOIR" as const, params: {} };
    const hostOnly = client(0, { kind: "host", plays: false });
    // the third guest alone (joinIndex 3) used to sing the whole song a fifth up
    for (const j of [1, 2, 3, 5, 6, 7]) {
      const a = plan(room([hostOnly, client(j)], CHOIR));
      expect(a[`c${j}-00000000`]!.pitchSemitones).toBe(0);
      expect(a[`c${j}-00000000`]!.label).toBe("choir");
    }
    // two guests left behind: root + fifth, not octave + fifth
    const pair = plan(room([hostOnly, client(1), client(3)], CHOIR));
    expect([pair["c1-00000000"]!.pitchSemitones, pair["c3-00000000"]!.pitchSemitones]).toEqual([0, 7]);
    // the root phone goes offline: the earliest phone still there takes the root
    const rootGone = plan(room([hostOnly, client(1, { connected: false }), client(2), client(3)], CHOIR));
    expect(rootGone["c2-00000000"]!.pitchSemitones).toBe(0);
    expect(rootGone["c3-00000000"]!.pitchSemitones).toBe(7);
    // random rooms: a connected root whenever anyone is connected, and a joiner re-pitches nobody
    const r = prng(1010);
    for (let i = 0; i < 1000; i++) {
      const joins = r.shuffle(Array.from({ length: 120 }, (_, k) => k)).slice(0, r.int(1, 30)).sort((x, y) => x - y);
      const clients = joins.map((j) => client(j, { plays: r.bool(0.9), connected: r.bool(0.8), kind: r.bool(0.1) ? "host" : "player" }));
      const a = plan(room(clients, CHOIR));
      const speakers = clients.filter((c) => c.plays);
      const present = speakers.some((c) => c.connected) ? speakers.filter((c) => c.connected) : speakers;
      if (present.length > 0) expect(present.some((c) => a[c.id]!.pitchSemitones === 0), `case ${i}`).toBe(true);
      const grown = plan(room([...clients, client(joins[joins.length - 1]! + r.int(1, 9))], CHOIR));
      // (unless a phone was only covering for an offline root and the joiner is a root: it hands the root back)
      const covering = present.length > 0 && present[0] !== speakers[0] && !present.some((c) => c.joinIndex % 4 === 0);
      if (!covering) for (const c of speakers) expect(grown[c.id]!.pitchSemitones, `case ${i}`).toBe(a[c.id]!.pitchSemitones!);
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

  test("STEREO never plays half a song: with nobody on one side, everyone plays the full mix (PROTO-06)", () => {
    const STEREO = { kind: "STEREO" as const, params: {} };
    const all = [...STEMS].sort();
    // one phone alone — before, it played drums+bass or vocals+other and the rest of the song was gone
    const lone = plan(room([client(0, { kind: "host", plays: false }), client(1)], STEREO));
    expect(audible(lone["c1-00000000"]!.gainsDb)).toEqual(all);
    expect(lone["c1-00000000"]!.label).toBe("unison");
    // every dot dragged into the left half
    const leftOnly = plan(room([client(1, { position: { x: 0.1, y: 0.2 } }), client(2, { position: { x: 0.3, y: 0.8 } })], STEREO));
    for (const v of Object.values(leftOnly)) expect(audible(v!.gainsDb)).toEqual(all);
    // the only phone on the right is offline: the left side covers until it is back
    const rightGone = plan(room([client(1, { position: { x: 0.1, y: 0.5 } }), client(2, { position: { x: 0.9, y: 0.5 }, connected: false })], STEREO));
    expect(audible(rightGone["c1-00000000"]!.gainsDb)).toEqual(all);
    // and with both sides present it is the real split
    const both = plan(room([client(1, { position: { x: 0.1, y: 0.5 } }), client(2, { position: { x: 0.9, y: 0.5 } })], STEREO));
    expect(both["c1-00000000"]!.label).toBe("left");
    expect(audible(both["c1-00000000"]!.gainsDb)).toEqual(["bass", "drums"]);
    expect(audible(both["c2-00000000"]!.gainsDb)).toEqual(["other", "vocals"]);
  });

  test("WAVE delay grows along the axis up to spanMs and carries a wave pattern", () => {
    const r3 = room([client(0, { position: { x: 0, y: 0 } }), client(1, { position: { x: 1, y: 0 } }), client(2)], { kind: "WAVE", params: { axis: "x", spanMs: 300 } });
    const a = plan(r3);
    expect(a["c0-00000000"]!.delayMs).toBe(0);
    expect(a["c1-00000000"]!.delayMs).toBe(300);
    // Deliberately changed (PROTO-04): this used to assert 150 — "unplaced → the middle of the axis". That
    // rule is the bug: the map draws an unplaced phone at an auto-layout slot, and the planner now reads the
    // same slot. joinIndex 2 sits at x = 0.69.
    expect(speakerLayout(r3).positions["c2-00000000"]!.x).toBe(0.69);
    expect(a["c2-00000000"]!.delayMs).toBe(207);
    expect(a["c1-00000000"]!.pattern?.kind).toBe("wave");
  });

  test("WAVE sweeps a room nobody has dragged: auto-placed phones get distinct delays and swell phases", () => {
    // host (joinIndex 0, not a speaker) + six guests, every position null — the state of every real party
    const guests = [1, 2, 3, 4, 5, 6].map((i) => client(i));
    const r = room([client(0, { kind: "host", plays: false }), ...guests], { kind: "WAVE", params: { axis: "x", spanMs: 240 } });
    const a = plan(r);
    const where = speakerLayout(r).positions;
    const delays = guests.map((g) => a[g.id]!.delayMs);
    // before the shared layout every one of these was 120 ms with phase 1000: no wave at all
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(80);
    expect(new Set(guests.map((g) => a[g.id]!.pattern!.phaseMs)).size).toBeGreaterThanOrEqual(4);
    // and it is the position the map draws, not some other number
    for (const g of guests) {
      expect(a[g.id]!.delayMs).toBe(Math.round(240 * where[g.id]!.x));
      expect(a[g.id]!.pattern!.phaseMs).toBe(Math.round(where[g.id]!.x * 2000));
    }
    // along y too
    const ay = plan({ ...r, mode: { kind: "WAVE", params: { axis: "y", spanMs: 240 } } });
    for (const g of guests) expect(ay[g.id]!.delayMs).toBe(Math.round(240 * where[g.id]!.y));
  });

  test("STEREO follows the dot: an auto-placed phone is on the side of the map it is drawn on", () => {
    const guests = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => client(i));
    const r = room([client(0, { kind: "host", plays: false }), ...guests], { kind: "STEREO", params: {} });
    const a = plan(r);
    const where = speakerLayout(r).positions;
    for (const g of guests) expect(a[g.id]!.label).toBe(where[g.id]!.x < 0.5 ? "left" : "right");
    expect(guests.filter((g) => a[g.id]!.label === "left")).toHaveLength(4); // the slots alternate sides
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
