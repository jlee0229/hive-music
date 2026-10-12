/**
 * Hive Map auto-layout: where phones nobody has dragged yet are drawn, and how big the dots are.
 * Pure — no React, no DOM — so it is unit-tested (map-layout.test.ts) and so the position half can be
 * swapped for the shared layout function planned in @hive/protocol (the planner needs the same
 * positions the map draws): replace the body of `autoLayout` with a call to it and keep `dotMetrics`.
 *
 * The layout is a honeycomb filled from the centre out. When the phones no longer fit, the whole map
 * steps down a size instead of stacking arrivals on one spot, down to a floor that still holds
 * MAX_PLAYERS.
 */

export interface XY {
  x: number;
  y: number;
}

/** The map's viewBox is MAP_SIZE × MAP_SIZE; positions are 0..1 across it. */
export const MAP_SIZE = 350;
/** Dot sizes, largest first. 1 is the design size; the last one fits MAX_PLAYERS (64) with room to spare. */
export const DOT_SCALES = [1, 0.84, 0.72, 0.62, 0.54, 0.48] as const;

export interface DotMetrics {
  /** Outer (health) ring radius, viewBox px. */
  ring: number;
  /** Filled disc radius. */
  fill: number;
  ringWidth: number;
  /** Name label font size, and its baseline offset below the dot centre. */
  font: number;
  labelDy: number;
  /** Characters of a name that fit under one dot before it runs into its neighbour. */
  labelChars: number;
  /** Centre-to-centre spacing of the honeycomb at this size. */
  pitchX: number;
  pitchY: number;
}

export function dotMetrics(scale: number): DotMetrics {
  const ring = 24 * scale;
  const font = Math.max(8, Math.round(11 * scale));
  // A row must clear its own label before the next row's ring starts.
  const pitchY = 2 * ring + font + 7;
  const pitchX = pitchY / (Math.sqrt(3) / 2);
  return {
    ring,
    fill: 17 * scale,
    ringWidth: Math.max(1.5, 3 * scale),
    font,
    labelDy: ring + font + 3,
    labelChars: Math.max(4, Math.floor(pitchX / (font * 0.56))),
    pitchX,
    pitchY,
  };
}

/** The rectangle a dot centre may sit in so that neither its ring nor its label is clipped by the map edge. */
export function centreBounds(m: DotMetrics): { minX: number; maxX: number; minY: number; maxY: number } {
  return { minX: m.ring + 3, maxX: MAP_SIZE - m.ring - 3, minY: m.ring + 3, maxY: MAP_SIZE - m.labelDy - 4 };
}

/** Where a dot at normalized `p` is actually drawn (viewBox px): pulled inside the map so an edge-dragged phone stays whole. */
export function drawnCentre(p: XY, m: DotMetrics): XY {
  const b = centreBounds(m);
  return { x: Math.min(b.maxX, Math.max(b.minX, p.x * MAP_SIZE)), y: Math.min(b.maxY, Math.max(b.minY, p.y * MAP_SIZE)) };
}

/**
 * Every honeycomb slot at this dot size, nearest the centre first (normalized 0..1). Deterministic.
 * `dotCentred` forces a dot on the exact centre of the map (the look of a small hive); otherwise the
 * fullest arrangement wins.
 */
export function honeycombSlots(scale: number, dotCentred = false): XY[] {
  const m = dotMetrics(scale);
  const b = centreBounds(m);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const eps = 0.01;
  // A honeycomb can be centred on a dot or on a gap, along either axis; which one packs more rows
  // and columns into the square depends on the dot size, so build all four and keep the fullest.
  let best: Array<XY & { d: number; a: number }> = [];
  for (const rowShift of dotCentred ? [0] : [0, 0.5]) {
    for (const colShift of dotCentred ? [0] : [0, 0.5]) {
      const out: typeof best = [];
      const rows = Math.ceil((b.maxY - cy) / m.pitchY) + 1;
      const cols = Math.ceil((b.maxX - cx) / m.pitchX) + 1;
      for (let j = -rows; j <= rows; j++) {
        const y = cy + (j + rowShift) * m.pitchY;
        if (y < b.minY - eps || y > b.maxY + eps) continue;
        for (let i = -cols; i <= cols; i++) {
          const x = cx + (i + colShift + (Math.abs(j) % 2 === 1 ? 0.5 : 0)) * m.pitchX;
          if (x < b.minX - eps || x > b.maxX + eps) continue;
          out.push({ x: x / MAP_SIZE, y: y / MAP_SIZE, d: Math.hypot(x - cx, y - cy), a: Math.atan2(y - cy, x - cx) });
        }
      }
      if (out.length > best.length) best = out;
    }
  }
  best.sort((p, q) => (Math.abs(p.d - q.d) > eps ? p.d - q.d : p.a - q.a));
  return best.map(({ x, y }) => ({ x, y }));
}

export interface AutoLayout {
  positions: Record<string, XY>;
  /** The dot size everything on the map should be drawn at (one of DOT_SCALES). */
  scale: number;
}

/**
 * Places `unplacedIds` (already in join order) on the honeycomb, skipping slots that would touch
 * anything in `taken` (hand-placed phones, the host marker). Picks the largest dot size at which
 * everyone gets a slot of their own.
 */
export function autoLayout(unplacedIds: readonly string[], taken: readonly XY[]): AutoLayout {
  for (const scale of DOT_SCALES) {
    const clear = (2 * dotMetrics(scale).ring + 4) / MAP_SIZE;
    // Dot-centred first: the first phone belongs in the middle, for as long as that arrangement fits.
    for (const dotCentred of [true, false]) {
      const free = honeycombSlots(scale, dotCentred).filter((s) => taken.every((t) => Math.hypot(s.x - t.x, s.y - t.y) >= clear));
      if (free.length >= unplacedIds.length) {
        const positions: Record<string, XY> = {};
        unplacedIds.forEach((id, i) => (positions[id] = free[i]!));
        return { positions, scale };
      }
    }
  }
  // More phones than the densest honeycomb holds around the hand-placed ones (past MAX_PLAYERS, or
  // a map crowded by dragging): use every slot and go round again — spread out, never one pile.
  const scale = DOT_SCALES[DOT_SCALES.length - 1]!;
  const slots = honeycombSlots(scale);
  const positions: Record<string, XY> = {};
  unplacedIds.forEach((id, i) => (positions[id] = slots[i % slots.length]!));
  return { positions, scale };
}

/** "Christopher-James" → "Christoph…" when the neighbours are close. */
export function fitLabel(name: string, maxChars: number): string {
  return name.length <= maxChars ? name : `${name.slice(0, Math.max(1, maxChars - 1))}…`;
}
