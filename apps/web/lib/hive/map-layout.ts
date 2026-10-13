/**
 * Hive Map drawing geometry: how big the dots are and where a dot is drawn.
 *
 * *Where a phone is* comes from `speakerLayout(room)` in @hive/protocol — the same function the
 * planner uses for WAVE's sweep and STEREO's sides, so the map shows what the room hears. This file
 * only turns that layout's `spacing` into dot sizes. Pure — no React, no DOM — and unit-tested
 * (map-layout.test.ts).
 */

export interface XY {
  x: number;
  y: number;
}

/** The map's viewBox is MAP_SIZE × MAP_SIZE; positions are 0..1 across it. */
export const MAP_SIZE = 350;
/** Slot spacing (viewBox px) at which dots are drawn full size: the layout's base spacing, 0.19 × 350. */
const FULL_SIZE_SPACING_PX = 66;
/** Below this dot scale the name labels no longer fit between neighbours and are not drawn. */
export const LABEL_MIN_SCALE = 0.75;

/** Dot scale for a layout: full size up to 19 auto-placed phones, shrinking with the slot spacing after that. */
export function dotScale(layoutSpacing: number): number {
  return Math.min(1, (layoutSpacing * MAP_SIZE) / FULL_SIZE_SPACING_PX);
}

export interface DotMetrics {
  scale: number;
  /** Outer (health) ring radius, viewBox px. */
  ring: number;
  /** Filled disc radius. */
  fill: number;
  ringWidth: number;
  /** Radius of the invisible circle a finger grabs: never smaller than the dot, never reaching a neighbour. */
  hit: number;
  /** Whether names are drawn at this size. */
  showLabels: boolean;
  /** Name label font size, and its baseline offset below the dot centre. */
  font: number;
  labelDy: number;
  /** Characters of a name that fit under one dot before it runs into its neighbour. */
  labelChars: number;
}

export function dotMetrics(layoutSpacing: number): DotMetrics {
  const scale = dotScale(layoutSpacing);
  const pitch = layoutSpacing * MAP_SIZE;
  const ring = 24 * scale;
  const font = Math.max(8, Math.round(11 * scale));
  return {
    scale,
    ring,
    fill: 17 * scale,
    ringWidth: Math.max(1.5, 3 * scale),
    hit: Math.max(ring, Math.min(22, pitch / 2)),
    showLabels: scale >= LABEL_MIN_SCALE,
    font,
    labelDy: ring + font + 3,
    labelChars: Math.max(4, Math.floor(pitch / (font * 0.56))),
  };
}

/** The rectangle a dot centre may sit in so that neither its ring nor its label is clipped by the map edge. */
export function centreBounds(m: DotMetrics): { minX: number; maxX: number; minY: number; maxY: number } {
  return { minX: m.ring + 3, maxX: MAP_SIZE - m.ring - 3, minY: m.ring + 3, maxY: MAP_SIZE - (m.showLabels ? m.labelDy + 4 : m.ring + 3) };
}

/** Where a dot at normalized `p` is actually drawn (viewBox px): pulled inside the map so an edge-dragged phone stays whole. */
export function drawnCentre(p: XY, m: DotMetrics): XY {
  const b = centreBounds(m);
  return { x: Math.min(b.maxX, Math.max(b.minX, p.x * MAP_SIZE)), y: Math.min(b.maxY, Math.max(b.minY, p.y * MAP_SIZE)) };
}

/** "Christopher-James" → "Christoph…" when the neighbours are close. */
export function fitLabel(name: string, maxChars: number): string {
  return name.length <= maxChars ? name : `${name.slice(0, Math.max(1, maxChars - 1))}…`;
}
