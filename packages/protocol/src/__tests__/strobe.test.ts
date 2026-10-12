import { describe, expect, test } from "bun:test";
import { evaluatePattern } from "../pattern";
import { arrangeStrobe, plan } from "../planner";
import type { ClientRecord, RoomState } from "../room";
import { prng } from "./harness";
import { client, room, uncoveredFraction } from "./room-fixture";

const strobe = (params: RoomState["mode"]["params"]): RoomState["mode"] => ({ kind: "STROBE", params });
const host = client(0, { kind: "host", plays: false });

describe("STROBE never rotates through an empty group (PROTO-07)", () => {
  test("4 groups, 2 phones: two groups, not half a song of silence", () => {
    const r = room([host, client(1), client(2)], strobe({ groups: 4, beatsPerSwitch: 1 }), undefined, { bpm: 120 });
    const a = plan(r);
    const pats = [a["c1-00000000"]!.pattern!, a["c2-00000000"]!.pattern!];
    expect(arrangeStrobe(r, 4).groups).toBe(2);
    expect(uncoveredFraction(pats)).toBeLessThan(1e-9); // was 0.5
    expect(new Set([a["c1-00000000"]!.label, a["c2-00000000"]!.label])).toEqual(new Set(["strobe 1", "strobe 2"]));
  });

  test("2 groups, phones whose joinIndexes share a parity still land in different groups", () => {
    const r = room([host, client(1), client(3)], strobe({ groups: 2, beatsPerSwitch: 1 }), undefined, { bpm: 120 });
    const a = plan(r);
    expect(a["c1-00000000"]!.label).not.toBe(a["c3-00000000"]!.label); // both were "strobe 2": silence half the time
    expect(uncoveredFraction([a["c1-00000000"]!.pattern!, a["c3-00000000"]!.pattern!])).toBeLessThan(1e-9);
  });

  test("a group whose only phone is offline is not left in the rotation", () => {
    const phones = [client(1), client(2), client(3, { connected: false })];
    const r = room([host, ...phones], strobe({ groups: 3, beatsPerSwitch: 1 }), undefined, { bpm: 120 });
    const a = plan(r);
    expect(arrangeStrobe(r, 3).groups).toBe(2);
    expect(uncoveredFraction([a["c1-00000000"]!.pattern!, a["c2-00000000"]!.pattern!])).toBeLessThan(1e-9);
  });

  test("random rooms: every group in rotation has a connected speaker, groups are balanced, the rotation has no hole", () => {
    const r = prng(77);
    for (let i = 0; i < 1500; i++) {
      const n = r.int(1, 40);
      const joins = r.shuffle(Array.from({ length: 120 }, (_, k) => k)).slice(0, n);
      const clients: ClientRecord[] = joins.map((j) => client(j, { plays: r.bool(0.9), connected: r.bool(0.8), kind: r.bool(0.1) ? "host" : "player" }));
      const groups = r.int(1, 8);
      const rm = room(clients, strobe({ groups, beatsPerSwitch: r.pick([0.25, 0.5, 1, 2, 4]) }), undefined, { bpm: r.pick([60, 97.3, 120, 128, 174, 190]), beatOffsetSec: r.next() * 3 });
      const speakers = clients.filter((c) => c.plays);
      if (speakers.length === 0) continue;
      const present = speakers.some((c) => c.connected) ? speakers.filter((c) => c.connected) : speakers;
      const seating = arrangeStrobe(rm, groups);
      expect(seating.groups, `case ${i}`).toBe(Math.min(groups, present.length));
      const perGroup = Array.from({ length: seating.groups }, () => 0);
      for (const c of present) perGroup[seating.groupOf.get(c.id)!]!++;
      expect(Math.min(...perGroup), `case ${i}`).toBeGreaterThanOrEqual(1);
      expect(Math.max(...perGroup) - Math.min(...perGroup), `case ${i}`).toBeLessThanOrEqual(1);
      const a = plan(rm);
      const pats = present.map((c) => a[c.id]!.pattern!);
      // one group alone is a plain on/off strobe: half the period is its off-time by design
      expect(uncoveredFraction(pats), `case ${i}`).toBeLessThan(seating.groups === 1 ? 0.5 + 1e-9 : 1e-9);
    }
  });

  test("a joiner does not move anyone between groups once the rotation is full", () => {
    const r = prng(78);
    for (let i = 0; i < 500; i++) {
      const groups = r.int(1, 8);
      const n = r.int(groups, 40);
      const joins = r.shuffle(Array.from({ length: 120 }, (_, k) => k)).slice(0, n).sort((x, y) => x - y);
      const clients = joins.map((j) => client(j));
      const before = arrangeStrobe(room(clients, strobe({ groups })), groups);
      const after = arrangeStrobe(room([...clients, client(joins[joins.length - 1]! + r.int(1, 9))], strobe({ groups })), groups);
      for (const c of clients) expect(after.groupOf.get(c.id), `case ${i}`).toBe(before.groupOf.get(c.id)!);
    }
  });
});

describe("STROBE stays on the beat grid for the whole song (PROTO-08)", () => {
  const two = [host, client(1), client(2)];
  const patternsOf = (r: RoomState) => Object.values(plan(r)).filter((a) => a !== null).map((a) => a!.pattern!);
  /** Smallest distance from x to a multiple of m. */
  const offGrid = (x: number, m: number) => Math.abs(x - Math.round(x / m) * m);

  test("128 BPM: the rotation is 937.5 ms, not 938 — no drift after four minutes", () => {
    const pats = patternsOf(room(two, strobe({ groups: 2, beatsPerSwitch: 1 }), undefined, { bpm: 128 }));
    expect(pats[0]!.periodMs).toBe(937.5);
    // the switch nearest the end of a 240 s song, against the true beat grid (468.75 ms): was 128 ms late
    const beat = 60000 / 128;
    const lastSwitch = pats[0]!.phaseMs + Math.floor(240_000 / pats[0]!.periodMs) * pats[0]!.periodMs;
    expect(offGrid(lastSwitch, beat)).toBeLessThan(1e-6);
  });

  test("the rotation is never clamped off the grid: 8 groups of half notes at 70 BPM is 13.7 s", () => {
    const eight = [host, ...Array.from({ length: 8 }, (_, i) => client(i + 1))];
    const pats = patternsOf(room(eight, strobe({ groups: 8, beatsPerSwitch: 2 }), undefined, { bpm: 70 }));
    const halfNote = (60000 / 70) * 2;
    for (const p of pats) {
      expect(p.periodMs).toBeCloseTo(8 * halfNote, 9); // was clamped to 8000: a 1000 ms turn against a 1714 ms half note
      expect(p.duty! * p.periodMs).toBeCloseTo(halfNote, 9);
      expect(offGrid(p.phaseMs, halfNote)).toBeLessThan(1e-6);
    }
    expect(new Set(pats.map((p) => Math.round(p.phaseMs / halfNote))).size).toBe(8);
  });

  test("one group is a plain on/off strobe on the beat, not a gate that never closes", () => {
    const r = room([host, client(1), client(2), client(3)], strobe({ groups: 1, beatsPerSwitch: 1 }), undefined, { bpm: 120 });
    for (const p of patternsOf(r)) expect(p).toMatchObject({ periodMs: 1000, duty: 0.5, phaseMs: 0 }); // was period 500, duty 1
    // and a single phone asked for 4 groups gets the same thing rather than 25 % duty
    const lone = patternsOf(room([host, client(1)], strobe({ groups: 4, beatsPerSwitch: 1 }), undefined, { bpm: 120 }));
    expect(lone[0]).toMatchObject({ periodMs: 1000, duty: 0.5 });
  });

  test("a turn too short or too long is doubled / halved, never scaled, so it still lands on the grid", () => {
    // sixteenths at 480 BPM would be a 31 ms turn: doubled to 62.5 ms (an eighth)
    const fast = patternsOf(room(two, strobe({ groups: 2, beatsPerSwitch: 0.25 }), undefined, { bpm: 480 }))[0]!;
    expect(fast.duty! * fast.periodMs).toBeCloseTo(62.5, 9);
    // a nonsense tempo cannot park a phone in silence for minutes
    const slow = patternsOf(room(two, strobe({ groups: 2, beatsPerSwitch: 4 }), undefined, { bpm: 0.5 }))[0]!;
    expect(slow.duty! * slow.periodMs).toBeLessThanOrEqual(8000);
    expect(Math.log2((60000 / 0.5) * 4 / (slow.duty! * slow.periodMs)) % 1).toBe(0);
  });

  test("a beat offset longer than the rotation is the same gate; without a bpm the free-running params apply", () => {
    const at = (beatOffsetSec: number) => patternsOf(room(two, strobe({ groups: 2, beatsPerSwitch: 1 }), undefined, { bpm: 120, beatOffsetSec }));
    const near = at(0.25);
    const far = at(0.25 + 7); // 7 s = 7 whole rotations later
    for (let i = 0; i < near.length; i++) {
      expect(far[i]!.phaseMs).toBeCloseTo(near[i]!.phaseMs, 6);
      expect(far[i]!.phaseMs).toBeLessThan(far[i]!.periodMs);
      expect(far[i]!.phaseMs).toBeGreaterThanOrEqual(0);
    }
    const free = patternsOf(room(two, strobe({ groups: 2, periodMs: 700, duty: 0.4, beatsPerSwitch: 2 })));
    expect(free.map((p) => p.phaseMs).sort((a, b) => a - b)).toEqual([0, 350]);
    for (const p of free) expect(p).toMatchObject({ periodMs: 700, duty: 0.4 });
  });

  test("random tempos: every group opens exactly on a beat-grid line, for the whole of a 4-minute song", () => {
    const r = prng(808);
    for (let i = 0; i < 1500; i++) {
      const bpm = r.bool(0.5) ? r.int(60, 200) : 60 + r.next() * 140;
      const bps = r.pick([0.25, 0.5, 1, 2, 4]);
      const groups = r.int(1, 8);
      const beatOffsetSec = r.next() * 2;
      const phones = Array.from({ length: r.int(1, 12) }, (_, k) => client(k + 1));
      const rm = room([host, ...phones], strobe({ groups, beatsPerSwitch: bps }), undefined, { bpm, beatOffsetSec });
      const slot = (60000 / bpm) * bps; // within [50, 8000] for these ranges: no folding
      for (const p of patternsOf(rm)) {
        const turn = p.duty! * p.periodMs;
        expect(turn, `case ${i}`).toBeCloseTo(slot, 6);
        for (const k of [0, Math.floor(120_000 / p.periodMs), Math.floor(240_000 / p.periodMs)]) {
          expect(offGrid(p.phaseMs + k * p.periodMs - beatOffsetSec * 1000, slot), `case ${i}`).toBeLessThan(1e-5);
        }
        expect(Number.isFinite(p.phaseMs) && Number.isFinite(p.periodMs)).toBe(true);
      }
    }
  });
});

/**
 * Cross-agent reproductions, re-created here so they live next to the code that fixes them.
 *
 * ENGINE-DSP-03 (engine-dsp, commit 4619205, apps/server/src/upload/__tests__/bpm-grid.test.ts): three
 * `test.failing` cases measuring where group 0 actually switches on near 3:50 by scanning the pattern.
 * Ported verbatim — same room (one phone, joinIndex 0, a "mix" track), same scan, same 5 ms bound — and
 * they pass. Once this branch is merged those three `test.failing` must become `test` (a test.failing
 * that passes is reported as a failure).
 *
 * HOST-17 (host-ui): dead air measured from plan() + evaluatePattern() when the phones present do not
 * cover every group. Same measurement, now 0 %.
 */
describe("ENGINE-DSP-03 (ported): the planner keeps the strobe on the detected grid", () => {
  const strobeRoom = (bpm: number, groups: number, beatsPerSwitch: number, joinIndexes: number[] = [0]): RoomState =>
    room(joinIndexes.map((j) => client(j)), strobe({ groups, beatsPerSwitch }), ["mix"], { durationSec: 240, bpm, beatOffsetSec: 0 });
  /** Where a phone's gate actually opens nearest to `atMs`, by scanning the pattern itself (engine-dsp's helper). */
  const switchOnNear = (r: RoomState, atMs: number, id = "c0-00000000"): number => {
    const pattern = plan(r)[id]!.pattern!;
    let best = Infinity;
    for (let t = atMs - 2000; t < atMs + 2000; t += 0.25) {
      if (evaluatePattern(pattern, t - 0.25) === 0 && evaluatePattern(pattern, t) > 0 && Math.abs(t - atMs) < Math.abs(best - atMs)) best = t;
    }
    return best;
  };

  for (const [groups, beatsPerSwitch] of [[2, 1], [2, 0.25], [3, 1]] as const) {
    test(`128 BPM, ${groups} groups, ${beatsPerSwitch} beat(s) per switch: the switch at ~3:50 is within 5 ms of a beat`, () => {
      const beatMs = 60000 / 128;
      const rotationMs = beatMs * beatsPerSwitch * groups;
      const k = Math.round(230000 / rotationMs);
      const expected = k * rotationMs; // beatOffsetSec is 0: group 0 switches on at whole rotations
      expect(Math.abs(switchOnNear(strobeRoom(128, groups, beatsPerSwitch), expected) - expected)).toBeLessThan(5);
    });
  }

  test("the same, measured where it matters: the half-gain point of every group's opening edge is on a grid line at 0:00, 2:00 and 3:50", () => {
    // The gate starts to open half a ramp (5 ms) before the beat and is at exactly 0.5 ON the beat, which is why the
    // scan above lands 4.75–4.9 ms early. The switch instant itself is the 0.5 crossing; it must be on the grid to the microsecond.
    for (const bpm of [128, 128.004, 93.871, 174.5]) {
      for (const [groups, beatsPerSwitch] of [[2, 1], [2, 0.25], [3, 1], [4, 0.5], [8, 2]] as const) {
        const phones = Array.from({ length: groups }, (_, i) => i + 1);
        const r = strobeRoom(bpm, groups, beatsPerSwitch, phones);
        const slot = (60000 / bpm) * beatsPerSwitch;
        const a = plan(r);
        for (const j of phones) {
          const p = a[`c${j}-00000000`]!.pattern!;
          for (const around of [0, 120_000, 230_000]) {
            const open = p.phaseMs + Math.round((around - p.phaseMs) / p.periodMs) * p.periodMs; // this group's opening nearest `around`
            expect(evaluatePattern(p, open), `${bpm} BPM ${groups}×${beatsPerSwitch}`).toBeCloseTo(0.5, 6);
            const gridLine = Math.round(open / slot) * slot;
            expect(Math.abs(open - gridLine), `${bpm} BPM ${groups}×${beatsPerSwitch} @${around}`).toBeLessThan(1e-6);
          }
        }
      }
    }
  });

  test("fractional periods and phases survive the wire and evaluate identically after a JSON round trip", () => {
    const r = strobeRoom(128, 2, 0.25, [1, 2]); // 234.375 ms rotation, 117.1875 ms phase
    const p = plan(r)["c2-00000000"]!.pattern!;
    expect(p.periodMs).toBe(234.375);
    const wire = JSON.parse(JSON.stringify(p)) as typeof p;
    expect(wire).toEqual(p);
    for (let t = 0; t < 240_000; t += 997.3) expect(evaluatePattern(wire, t)).toBe(evaluatePattern(p, t));
  });
});

describe("HOST-17 (ported): no dead air when the phones present do not cover every group", () => {
  /** Fraction of a rotation during which the summed gate of the given phones is (near) zero. */
  function deadAir(r: RoomState): number {
    const pats = Object.values(plan(r)).filter((a) => a !== null).map((a) => a!.pattern!);
    const period = pats[0]!.periodMs;
    let silent = 0;
    const steps = 4000;
    for (let i = 0; i < steps; i++) if (pats.reduce((acc, p) => acc + evaluatePattern(p, (i / steps) * period), 0) < 0.01) silent++;
    return silent / steps;
  }
  const at120 = (joinIndexes: number[], groups: number) => room([host, ...joinIndexes.map((j) => client(j))], strobe({ groups, beatsPerSwitch: 1 }), undefined, { bpm: 120 });

  test("2 phones with join indexes 1 and 3 on 2 groups: was 51 % silent", () => {
    expect(deadAir(at120([1, 3], 2))).toBe(0);
  });
  test("5 phones on 8 groups: was 39 % silent", () => {
    const r = at120([1, 2, 3, 4, 5], 8);
    expect(arrangeStrobe(r, 8).groups).toBe(5);
    expect(deadAir(r)).toBe(0);
  });
  test("every offered group count (2, 3, 4, 5, 6, 8) with 1 … 12 phones at arbitrary join indexes", () => {
    const rng = prng(1717);
    for (const groups of [2, 3, 4, 5, 6, 8]) {
      for (let n = 1; n <= 12; n++) {
        const joins = rng.shuffle(Array.from({ length: 60 }, (_, k) => k + 1)).slice(0, n);
        const r = at120(joins, groups);
        // the contract the host page can rely on: the effective count is min(requested, speakers present)
        expect(arrangeStrobe(r, groups).groups).toBe(Math.min(groups, n));
        // one phone alone is an on/off strobe (half the rotation off, by design); otherwise there is no dead air at all
        if (n === 1) expect(deadAir(r)).toBeCloseTo(0.49, 1);
        else expect(deadAir(r), `${groups} groups × ${n} phones`).toBe(0);
      }
    }
  });
});
