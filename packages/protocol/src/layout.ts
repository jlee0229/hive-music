import type { ClientRecord, Position, RoomState } from "./room";

/**
 * Auto-layout: where a speaker that nobody has dragged sits on the Hive Map.
 *
 * ONE function, shared by the planner (WAVE's delay and swell phase, STEREO's side) and by the map that
 * draws the dots — so what the host sees is what the room hears. Before this existed the map invented
 * positions in a React component while the server-side record stayed `position: null`, which the planner
 * read as "the middle": with nobody dragged, WAVE gave every phone the same delay (no sweep at all) and
 * STEREO ignored where the dot was drawn.
 *
 * Shape: a hive forming from the centre out. Slot 0 is the centre; ring k (k = 1, 2, …) is a circle of
 * radius k·spacing carrying 6k evenly spaced slots, so `rings` rings hold 1 + 3·rings·(rings+1) slots
 * (19, 37, 61, 91, …) and any two slots are at least `spacing` apart.
 *
 * Properties the tests pin down:
 *  - **pure and deterministic** — a function of the set of unplaced speakers (id, joinIndex) and the
 *    positions of the placed ones; input order is irrelevant.
 *  - **collision-free** — distinct slots, ≥ `spacing` apart, and no auto slot within 0.9·spacing of a
 *    phone the host placed by hand.
 *  - **stable** — a speaker's preferred slot is `joinIndex mod capacity`, and lower joinIndex wins a
 *    contested slot. A new joiner therefore never moves anyone already on the map, and a leaver moves
 *    nobody unless someone had been bumped off a slot by a collision (only possible once joinIndex
 *    exceeds the capacity, i.e. after a lot of churn). Rank-based packing would be prettier and would
 *    re-seat — and in WAVE, re-delay — every later phone each time one record expired.
 *  - **scales** — the ring count grows with the head count; the dots get closer, never stacked. Up to 19
 *    speakers the geometry is exactly the map's historical look (rings at 0.19 and 0.38). The layout
 *    rescales only when the count crosses 19 / 37 / 61 / … .
 *
 * Slot order inside a ring is "most horizontal first, alternating left / right", so the first phones in
 * a room are spread along x (a WAVE with three phones still travels) and STEREO's two sides fill evenly.
 * No ring slot lies on the vertical centre line: `x < 0.5` is never decided by floating-point noise.
 */

/** Slot spacing while the hive has at most two rings (≤ 19 auto-placed speakers), in map units. */
export const LAYOUT_BASE_SPACING = 0.19;
/** Outermost ring radius: keeps a dot and its name label inside the unit square. */
export const LAYOUT_MAX_RADIUS = 0.42;
/** Most rings the layout will grow to: 1 + 3·8·9 = 217 slots. */
export const LAYOUT_MAX_RINGS = 8;
/** An auto slot closer than this fraction of `spacing` to a hand-placed phone is skipped. */
export const LAYOUT_OBSTACLE_CLEARANCE = 0.9;

export interface AutoLayout {
  /** Position per auto-placed client id. */
  positions: Record<string, Position>;
  /** Guaranteed minimum distance between any two auto slots (map units). The map sizes its dots from it. */
  spacing: number;
  /** Rings in use (2 … LAYOUT_MAX_RINGS). */
  rings: number;
}

export function layoutCapacity(rings: number): number {
  return 1 + 3 * rings * (rings + 1);
}

export function layoutSpacing(rings: number): number {
  return Math.min(LAYOUT_BASE_SPACING, LAYOUT_MAX_RADIUS / rings);
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Unit-offset slot table (multiply by spacing, add the centre). Slot indices are nested: the first
 * `layoutCapacity(r)` entries are the same for every ring count ≥ r, so a speaker whose joinIndex is below
 * the capacity keeps its slot index when the hive grows a ring — only the scale changes.
 */
const UNIT_SLOTS: Array<{ ux: number; uy: number }> = (() => {
  const out: Array<{ ux: number; uy: number }> = [{ ux: 0, uy: 0 }];
  for (let k = 1; k <= LAYOUT_MAX_RINGS; k++) {
    const n = 6 * k;
    const step = (2 * Math.PI) / n;
    // Odd rings start at 0°, even rings half a step in: both are mirror-symmetric about the vertical
    // axis and neither puts a slot at 90° / 270° (which would sit exactly on x = 0.5).
    const offset = k % 2 === 1 ? 0 : step / 2;
    const ring: Array<{ ux: number; uy: number }> = [];
    for (let j = 0; j < n; j++) {
      const a = offset + j * step;
      ring.push({ ux: round4(k * Math.cos(a)), uy: round4(k * Math.sin(a)) });
    }
    // most horizontal first; left before right; upper before lower (y grows downward on the map)
    ring.sort((p, q) => Math.abs(q.ux) - Math.abs(p.ux) || p.ux - q.ux || p.uy - q.uy);
    // interleave left / right so consecutive slot indices sit on opposite sides
    const left = ring.filter((p) => p.ux < 0);
    const right = ring.filter((p) => p.ux > 0);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i]) out.push(left[i]!);
      if (right[i]) out.push(right[i]!);
    }
  }
  return out;
})();

/** The slot table for a ring count, in map coordinates (0..1, origin top-left, y down). */
export function layoutSlots(rings: number): Position[] {
  const d = layoutSpacing(rings);
  return UNIT_SLOTS.slice(0, layoutCapacity(rings)).map((s) => ({ x: round4(0.5 + s.ux * d), y: round4(0.5 + s.uy * d) }));
}

/**
 * Lays out the speakers that have no position. `obstacles` are the positions of the speakers the host
 * placed by hand; auto slots keep clear of them.
 */
export function autoLayout(unplaced: ReadonlyArray<Pick<ClientRecord, "id" | "joinIndex">>, obstacles: ReadonlyArray<Position> = []): AutoLayout {
  const order = [...unplaced].sort((a, b) => a.joinIndex - b.joinIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let rings = 2;
  while (rings < LAYOUT_MAX_RINGS && layoutCapacity(rings) < order.length) rings++;

  for (; rings <= LAYOUT_MAX_RINGS; rings++) {
    const spacing = layoutSpacing(rings);
    const slots = layoutSlots(rings);
    const clear = spacing * LAYOUT_OBSTACLE_CLEARANCE;
    const free = slots.map((s) => obstacles.every((o) => Math.hypot(s.x - o.x, s.y - o.y) >= clear));
    if (free.filter(Boolean).length < order.length) continue; // hand-placed phones ate too many slots: grow a ring
    const positions: Record<string, Position> = Object.create(null) as Record<string, Position>;
    for (const c of order) {
      let i = ((c.joinIndex % slots.length) + slots.length) % slots.length;
      while (!free[i]) i = (i + 1) % slots.length; // terminates: free slots ≥ speakers still to seat
      free[i] = false;
      positions[c.id] = slots[i]!;
    }
    return { positions, spacing, rings };
  }

  // More speakers than the largest hive holds (> 217): seat who fits, stack the rest on the centre.
  const slots = layoutSlots(LAYOUT_MAX_RINGS);
  const positions: Record<string, Position> = Object.create(null) as Record<string, Position>;
  order.forEach((c, i) => (positions[c.id] = slots[i] ?? { x: 0.5, y: 0.5 }));
  return { positions, spacing: layoutSpacing(LAYOUT_MAX_RINGS), rings: LAYOUT_MAX_RINGS };
}

/**
 * Where every speaker in the room effectively is: its own position if the host placed it, its auto slot
 * otherwise. Computed over every `plays` record — connected or not, exactly the set `plan()` assigns —
 * so a phone that drops for a minute comes back to the same spot. The planner and the Hive Map both call
 * this; a map that draws only the connected speakers must still lay out all of them.
 */
export function speakerLayout(room: Pick<RoomState, "clients">): AutoLayout {
  const speakers = Object.values(room.clients).filter((c) => c.plays);
  const placed = speakers.filter((c) => c.position !== null);
  const auto = autoLayout(speakers.filter((c) => c.position === null), placed.map((c) => c.position!));
  for (const c of placed) auto.positions[c.id] = c.position!;
  return auto;
}
