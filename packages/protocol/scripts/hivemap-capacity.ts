/**
 * Audit repro (protocol-planner, PROTO-04): the ring layout that lived in apps/web/components/HiveMap.tsx,
 * copied verbatim, asked how many phones it can seat before everyone lands on the centre fallback —
 * next to the shared layout in packages/protocol/src/layout.ts.
 *   bun run packages/protocol/scripts/hivemap-capacity.ts
 */
import { autoLayout } from "../src/layout";

function oldHiveMapLayout(n: number, hostMarker: { x: number; y: number } | null = { x: 0.1, y: 0.9 }) {
  const MIN_DIST = 0.17;
  const slots: Array<{ x: number; y: number }> = [{ x: 0.5, y: 0.5 }];
  for (let k = 1; k <= 6; k++) {
    const r = Math.min(0.19 * k, 0.42);
    const count = 6 * k;
    for (let j = 0; j < count; j++) {
      const a = (2 * Math.PI * j) / count + k * 0.5;
      slots.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
    }
  }
  const taken = hostMarker ? [hostMarker] : [];
  const out: Array<{ x: number; y: number }> = [];
  let fallbacks = 0;
  for (let i = 0; i < n; i++) {
    const found = slots.find((s) => taken.every((t) => Math.hypot(s.x - t.x, s.y - t.y) >= MIN_DIST));
    if (!found) fallbacks++;
    const slot = found ?? { x: 0.5, y: 0.5 };
    out.push(slot);
    taken.push(slot);
  }
  return { out, fallbacks, slots: slots.length };
}

const minDist = (ps: Array<{ x: number; y: number }>) => {
  let m = Infinity;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) m = Math.min(m, Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y));
  return m;
};

console.log("phones | old: stacked on centre, min distance | shared: rings, spacing, min distance");
for (const n of [6, 12, 18, 19, 20, 24, 30, 40, 60, 64]) {
  const old = oldHiveMapLayout(n);
  const neu = autoLayout(Array.from({ length: n }, (_, i) => ({ id: `c${i}`, joinIndex: i + 1 })));
  console.log(
    `${String(n).padStart(6)} | ${String(old.fallbacks).padStart(3)} stacked, min ${minDist(old.out).toFixed(3)}`.padEnd(40),
    `| ${neu.rings} rings, spacing ${neu.spacing.toFixed(3)}, min ${minDist(Object.values(neu.positions)).toFixed(3)}`,
  );
}
const ps = autoLayout(Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, joinIndex: i }))).positions;
console.log("first 8 shared slots (joinIndex 0..7):", Object.values(ps).map((p) => `(${p.x}, ${p.y})`).join(" "));
