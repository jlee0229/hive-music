import { describe, expect, test } from "bun:test";
import { MAX_PLAYERS } from "../constants";
import {
  LAYOUT_BASE_SPACING, LAYOUT_MAX_RADIUS, LAYOUT_MAX_RINGS, LAYOUT_OBSTACLE_CLEARANCE,
  autoLayout, layoutCapacity, layoutSlots, layoutSpacing, speakerLayout,
} from "../layout";
import type { ClientRecord, Position } from "../room";
import { prng } from "./harness";

const EPS = 5e-4; // slots are rounded to 4 decimals
const c = (joinIndex: number, id = `c${joinIndex}-00000000`) => ({ id, joinIndex });
const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => c(from + i));
const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);
function minPairDistance(ps: Position[]): number {
  let m = Infinity;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, dist(ps[i]!, ps[j]!));
  return m;
}

describe("autoLayout — the shared Hive Map layout (PROTO-04)", () => {
  test("capacity: 19 / 37 / 61 / 91 slots, and every slot table really is collision-free and in bounds", () => {
    expect([2, 3, 4, 5].map(layoutCapacity)).toEqual([19, 37, 61, 91]);
    for (let rings = 2; rings <= LAYOUT_MAX_RINGS; rings++) {
      const slots = layoutSlots(rings);
      expect(slots).toHaveLength(layoutCapacity(rings));
      expect(minPairDistance(slots)).toBeGreaterThanOrEqual(layoutSpacing(rings) - EPS);
      for (const s of slots) {
        expect(dist(s, { x: 0.5, y: 0.5 })).toBeLessThanOrEqual(LAYOUT_MAX_RADIUS + EPS);
        // nothing sits on the vertical centre line except the centre itself: STEREO's `x < 0.5` is never a coin toss
        if (s.x !== 0.5 || s.y !== 0.5) expect(Math.abs(s.x - 0.5)).toBeGreaterThan(0.01);
      }
    }
    // the first two rings are exactly the map's historical geometry
    expect(layoutSpacing(2)).toBe(LAYOUT_BASE_SPACING);
  });

  test("1 … 200 speakers: everyone gets a distinct slot at least `spacing` from every other", () => {
    for (const n of [1, 2, 3, 7, 19, 20, 37, 38, 60, MAX_PLAYERS, 91, 92, 150, 200]) {
      const { positions, spacing, rings } = autoLayout(range(n));
      const ps = Object.values(positions);
      expect(ps, `n=${n}`).toHaveLength(n);
      if (n > 1) expect(minPairDistance(ps), `n=${n}`).toBeGreaterThanOrEqual(spacing - EPS);
      expect(layoutCapacity(rings)).toBeGreaterThanOrEqual(n);
      for (const p of ps) {
        expect(p.x).toBeGreaterThanOrEqual(0.05);
        expect(p.x).toBeLessThanOrEqual(0.95);
        expect(p.y).toBeGreaterThanOrEqual(0.05);
        expect(p.y).toBeLessThanOrEqual(0.95);
      }
    }
    // 60 phones still get dots a visible distance apart (≥ 36 px on the 350 px map)
    expect(autoLayout(range(60)).spacing).toBeGreaterThanOrEqual(0.105 - 1e-9);
    // and more than the largest hive degrades to stacking on the centre instead of throwing
    expect(Object.keys(autoLayout(range(300)).positions)).toHaveLength(300);
  });

  test("deterministic: input order is irrelevant", () => {
    const r = prng(7);
    for (let i = 0; i < 50; i++) {
      const set = range(r.int(1, 70), r.int(0, 300));
      const obstacles = Array.from({ length: r.int(0, 4) }, () => ({ x: r.next(), y: r.next() }));
      expect(autoLayout(r.shuffle(set), obstacles)).toEqual(autoLayout(set, obstacles));
    }
  });

  test("stable on join: a newcomer never moves anyone already on the map (within a ring count)", () => {
    const r = prng(11);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      // an arbitrary surviving subset of a long-running room: sparse joinIndex values, some past the capacity
      const n = r.int(1, 60);
      const pool = r.shuffle(Array.from({ length: 400 }, (_, k) => k)).slice(0, n).sort((a, b) => a - b);
      const before = autoLayout(pool.map((j) => c(j)));
      const newcomer = c(pool[pool.length - 1]! + r.int(1, 50));
      const after = autoLayout([...pool.map((j) => c(j)), newcomer]);
      if (after.rings !== before.rings) continue; // the hive grew a ring: the one case everybody rescales
      checked++;
      for (const j of pool) expect(after.positions[c(j).id], `case ${i}`).toEqual(before.positions[c(j).id]!);
    }
    expect(checked).toBeGreaterThan(250);
  });

  test("stable on leave: with no contested slot, a leaver moves nobody", () => {
    const r = prng(13);
    for (let i = 0; i < 300; i++) {
      const n = r.int(2, 19);
      const pool = r.shuffle(Array.from({ length: 19 }, (_, k) => k)).slice(0, n); // joinIndex < capacity → distinct preferred slots
      const before = autoLayout(pool.map((j) => c(j)));
      const gone = r.pick(pool);
      const after = autoLayout(pool.filter((j) => j !== gone).map((j) => c(j)));
      for (const j of pool) if (j !== gone) expect(after.positions[c(j).id]).toEqual(before.positions[c(j).id]!);
    }
  });

  test("a leaver in a churned room moves at most the phones that had been bumped off their own slot", () => {
    const r = prng(17);
    for (let i = 0; i < 200; i++) {
      const n = r.int(2, 19);
      const pool = r.shuffle(Array.from({ length: 500 }, (_, k) => k)).slice(0, n);
      const before = autoLayout(pool.map((j) => c(j)));
      const slots = layoutSlots(before.rings);
      const bumped = new Set(pool.filter((j) => dist(before.positions[c(j).id]!, slots[j % slots.length]!) > EPS));
      const gone = r.pick(pool);
      const after = autoLayout(pool.filter((j) => j !== gone).map((j) => c(j)));
      for (const j of pool) if (j !== gone && !bumped.has(j)) expect(after.positions[c(j).id]).toEqual(before.positions[c(j).id]!);
    }
  });

  test("the first phones spread along x and alternate sides, so WAVE travels and STEREO splits with nobody dragged", () => {
    // the usual room: host is joinIndex 0 and not a speaker, guests are 1, 2, 3…
    const { positions } = autoLayout(range(6, 1));
    const xs = range(6, 1).map((k) => positions[k.id]!.x);
    expect(xs[0]!).toBeLessThan(0.35); // far left
    expect(xs[1]!).toBeGreaterThan(0.65); // far right
    for (let i = 0; i + 1 < xs.length; i += 2) expect(xs[i]! < 0.5 !== xs[i + 1]! < 0.5).toBe(true);
    // a host that also plays (joinIndex 0) is the centre of its own hive
    expect(autoLayout(range(1)).positions["c0-00000000"]).toEqual({ x: 0.5, y: 0.5 });
  });

  test("auto slots keep clear of hand-placed phones, and grow a ring when those eat the capacity", () => {
    const r = prng(19);
    for (let i = 0; i < 100; i++) {
      const obstacles = Array.from({ length: r.int(1, 12) }, () => ({ x: r.next(), y: r.next() }));
      const n = r.int(1, 64);
      const { positions, spacing } = autoLayout(range(n, r.int(0, 40)), obstacles);
      const ps = Object.values(positions);
      expect(ps).toHaveLength(n);
      for (const p of ps) for (const o of obstacles) expect(dist(p, o)).toBeGreaterThanOrEqual(spacing * LAYOUT_OBSTACLE_CLEARANCE - EPS);
      if (n > 1) expect(minPairDistance(ps)).toBeGreaterThanOrEqual(spacing - EPS);
    }
    // 19 speakers fit two rings; park a hand-placed phone on a slot and the 19 need a third ring
    expect(autoLayout(range(19)).rings).toBe(2);
    expect(autoLayout(range(19), [{ x: 0.5, y: 0.5 }]).rings).toBe(3);
  });

  test("speakerLayout: placed speakers keep their own position; non-speakers get none; disconnected speakers keep a slot", () => {
    const rec = (i: number, over: Partial<ClientRecord> = {}): ClientRecord => ({
      id: `c${i}-00000000`, kind: "player", plays: true, name: `P${i}`, device: { userAgent: "", platform: "x", browserFamily: "other" },
      joinIndex: i, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0, tableLatencyMs: null, calibratedOffsetMs: null,
      assignment: null, connected: true, audioReadyTrackId: null, ...over,
    });
    const clients = Object.fromEntries([
      rec(0, { kind: "host", plays: false }), rec(1), rec(2, { position: { x: 0.9, y: 0.1 } }), rec(3, { connected: false }), rec(4, { kind: "viewer", plays: false }),
    ].map((x) => [x.id, x]));
    const { positions } = speakerLayout({ clients });
    expect(Object.keys(positions).sort()).toEqual(["c1-00000000", "c2-00000000", "c3-00000000"]);
    expect(positions["c2-00000000"]).toEqual({ x: 0.9, y: 0.1 });
    expect(positions["c3-00000000"]).toEqual(autoLayout([c(1), c(3)]).positions["c3-00000000"]!);
  });
});
