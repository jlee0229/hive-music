// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { DOT_SCALES, MAP_SIZE, autoLayout, centreBounds, dotMetrics, drawnCentre, fitLabel, honeycombSlots, type XY } from "./map-layout";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

/** Smallest centre-to-centre distance between any two points, in viewBox px. */
function minGapPx(points: XY[]): number {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      min = Math.min(min, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y) * MAP_SIZE);
    }
  }
  return min;
}

describe("autoLayout", () => {
  test("the first phone sits in the middle of the map and the next six surround it", () => {
    const { positions, scale } = autoLayout(ids(7), []);
    expect(scale).toBe(1);
    const b = centreBounds(dotMetrics(1));
    expect(positions.p0!.x * MAP_SIZE).toBeCloseTo((b.minX + b.maxX) / 2, 5);
    expect(positions.p0!.y * MAP_SIZE).toBeCloseTo((b.minY + b.maxY) / 2, 5);
    const ring = ids(7).slice(1).map((id) => Math.hypot(positions[id]!.x - positions.p0!.x, positions[id]!.y - positions.p0!.y) * MAP_SIZE);
    expect(Math.max(...ring) - Math.min(...ring)).toBeLessThan(1);
  });

  // The old ring layout ran out of free slots after 19 phones and put every later one on the centre.
  for (const n of [1, 12, 19, 20, 25, 30, 40, 50, 64]) {
    test(`${n} unplaced phones: no two dots overlap and none is clipped by the map edge`, () => {
      const { positions, scale } = autoLayout(ids(n), [{ x: 0.1, y: 0.9 }]);
      const pts = Object.values(positions);
      expect(pts.length).toBe(n);
      const m = dotMetrics(scale);
      if (n > 1) expect(minGapPx(pts)).toBeGreaterThanOrEqual(2 * m.ring + 4);
      const b = centreBounds(m);
      for (const p of pts) {
        expect(p.x * MAP_SIZE).toBeGreaterThanOrEqual(b.minX - 0.01);
        expect(p.x * MAP_SIZE).toBeLessThanOrEqual(b.maxX + 0.01);
        expect(p.y * MAP_SIZE).toBeGreaterThanOrEqual(b.minY - 0.01);
        expect(p.y * MAP_SIZE).toBeLessThanOrEqual(b.maxY + 0.01);
      }
    });
  }

  test("a small party keeps full-size dots; the map only shrinks them when it has to", () => {
    expect(autoLayout(ids(12), []).scale).toBe(1);
    expect(autoLayout(ids(40), []).scale).toBeLessThan(1);
    expect(autoLayout(ids(64), []).scale).toBeGreaterThanOrEqual(DOT_SCALES[DOT_SCALES.length - 1]!);
  });

  test("auto-placed dots keep clear of hand-placed phones and of the host marker", () => {
    const taken = [
      { x: 0.5, y: 0.5 },
      { x: 0.25, y: 0.3 },
      { x: 0.1, y: 0.9 },
    ];
    const { positions, scale } = autoLayout(ids(15), taken);
    const clear = 2 * dotMetrics(scale).ring + 4;
    for (const p of Object.values(positions)) {
      for (const t of taken) expect(Math.hypot(p.x - t.x, p.y - t.y) * MAP_SIZE).toBeGreaterThanOrEqual(clear);
    }
  });

  test("the same room lays out the same way every time, and a newcomer never moves the others at the same size", () => {
    expect(autoLayout(ids(10), [])).toEqual(autoLayout(ids(10), []));
    const ten = autoLayout(ids(10), []);
    const eleven = autoLayout(ids(11), []);
    expect(eleven.scale).toBe(ten.scale);
    for (const id of ids(10)) expect(eleven.positions[id]).toEqual(ten.positions[id]);
  });

  test("past capacity (200 phones) it still spreads over every slot instead of piling onto one", () => {
    const { positions } = autoLayout(ids(200), []);
    const slots = honeycombSlots(DOT_SCALES[DOT_SCALES.length - 1]!).length;
    const distinct = new Set(Object.values(positions).map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
    expect(distinct.size).toBe(slots);
    expect(slots).toBeGreaterThanOrEqual(64);
  });
});

describe("dot drawing helpers", () => {
  test("a phone dragged to a corner is drawn whole, ring and label inside the map", () => {
    const m = dotMetrics(1);
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }]) {
      const c = drawnCentre(p, m);
      expect(c.x - m.ring).toBeGreaterThanOrEqual(0);
      expect(c.x + m.ring).toBeLessThanOrEqual(MAP_SIZE);
      expect(c.y - m.ring).toBeGreaterThanOrEqual(0);
      expect(c.y + m.labelDy).toBeLessThanOrEqual(MAP_SIZE);
    }
    expect(drawnCentre({ x: 0.5, y: 0.5 }, m)).toEqual({ x: 175, y: 175 });
  });

  test("long names are cut to what fits under one dot", () => {
    expect(fitLabel("Maya", 8)).toBe("Maya");
    expect(fitLabel("Christopher-James", 8)).toBe("Christo…");
    expect(fitLabel("Christopher-James", 8).length).toBe(8);
  });
});
