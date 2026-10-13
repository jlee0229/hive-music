// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { LAYOUT_BASE_SPACING, autoLayout, layoutSpacing } from "@hive/protocol";
import { LABEL_MIN_SCALE, MAP_SIZE, centreBounds, dotMetrics, dotScale, drawnCentre, fitLabel } from "./map-layout";

const phones = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `player-${String(i).padStart(3, "0")}`, joinIndex: i }));

describe("dot size follows the shared layout's spacing", () => {
  test("full size, with names, for as long as the hive has two rings (up to 19 phones)", () => {
    for (const n of [1, 3, 12, 19]) {
      const m = dotMetrics(autoLayout(phones(n)).spacing);
      expect(m.scale).toBe(1);
      expect(m.ring).toBe(24);
      expect(m.showLabels).toBe(true);
    }
    expect(dotScale(LAYOUT_BASE_SPACING)).toBe(1);
  });

  test("a bigger party shrinks the dots and drops the names instead of overlapping", () => {
    const forty = dotMetrics(autoLayout(phones(40)).spacing);
    const sixty = dotMetrics(autoLayout(phones(60)).spacing);
    expect(forty.scale).toBeLessThan(LABEL_MIN_SCALE);
    expect(forty.showLabels).toBe(false);
    expect(sixty.scale).toBeLessThanOrEqual(forty.scale);
  });

  // The layout guarantees `spacing` between any two auto slots; the drawing must fit inside that.
  for (const n of [1, 12, 19, 20, 37, 38, 40, 60, 64, 100, 217]) {
    test(`${n} phones: two neighbouring rings never touch, and no auto slot is clipped by the map edge`, () => {
      const layout = autoLayout(phones(n));
      const m = dotMetrics(layout.spacing);
      expect(2 * m.ring).toBeLessThan(layout.spacing * MAP_SIZE);
      expect(2 * m.hit).toBeLessThanOrEqual(Math.max(2 * m.ring, layout.spacing * MAP_SIZE) + 1e-9);
      const b = centreBounds(m);
      for (const p of Object.values(layout.positions)) {
        const c = drawnCentre(p, m);
        expect(c.x).toBeCloseTo(p.x * MAP_SIZE, 6); // not pulled in: drawn exactly where the planner has it
        expect(c.y).toBeCloseTo(p.y * MAP_SIZE, 6);
        expect(c.x).toBeGreaterThanOrEqual(b.minX);
        expect(c.x).toBeLessThanOrEqual(b.maxX);
        expect(c.y).toBeGreaterThanOrEqual(b.minY);
        expect(c.y).toBeLessThanOrEqual(b.maxY);
      }
    });
  }

  test("the finger-sized hit area never shrinks below the dot and never reaches into a neighbour", () => {
    for (const rings of [2, 3, 4, 5, 8]) {
      const spacing = layoutSpacing(rings);
      const m = dotMetrics(spacing);
      expect(m.hit).toBeGreaterThanOrEqual(m.ring);
      if (rings > 2) expect(m.hit).toBeLessThanOrEqual((spacing * MAP_SIZE) / 2 + 1e-9);
    }
  });
});

describe("dot drawing helpers", () => {
  test("a phone dragged to a corner is drawn whole, ring and label inside the map", () => {
    const m = dotMetrics(LAYOUT_BASE_SPACING);
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
