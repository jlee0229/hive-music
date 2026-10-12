import { describe, expect, test } from "bun:test";
import { arrangeStrobe, plan } from "../planner";
import type { Pattern } from "../pattern";
import type { ClientRecord, RoomState } from "../room";
import { prng } from "./harness";
import { client, room } from "./room-fixture";

const strobe = (params: RoomState["mode"]["params"]): RoomState["mode"] => ({ kind: "STROBE", params });
const host = client(0, { kind: "host", plays: false });

/** Fraction of one period during which none of the patterns' on-windows [phase, phase + duty·period) is open. */
export function uncoveredFraction(patterns: Pattern[]): number {
  const period = patterns[0]!.periodMs;
  const cuts: Array<[number, number]> = [];
  for (const p of patterns) {
    const start = ((p.phaseMs % period) + period) % period;
    const len = (p.duty ?? 0.5) * period;
    if (start + len <= period) cuts.push([start, start + len]);
    else cuts.push([start, period], [0, start + len - period]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = 0;
  for (const [a, b] of cuts) {
    if (b <= reach) continue;
    covered += b - Math.max(a, reach);
    reach = b;
  }
  return 1 - covered / period;
}

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
      // HOLE-CHECK
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
