// Small numeric helpers shared by the load / sizing scripts.

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(values: number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  return { n: s.length, min: s[0] ?? NaN, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1) ?? NaN, mean };
}

export const fmt = (v: number, digits = 1): string => (Number.isFinite(v) ? v.toFixed(digits) : "n/a");

export function fmtSummary(s: Summary, unit = "ms", digits = 1): string {
  return `p50=${fmt(s.p50, digits)} p95=${fmt(s.p95, digits)} p99=${fmt(s.p99, digits)} max=${fmt(s.max, digits)} ${unit} (n=${s.n})`;
}

/** `--flag value` pairs and bare `--flag` booleans. */
export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(flag.slice(2), next);
      i++;
    } else out.set(flag.slice(2), "1");
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so a sizing run is reproducible byte for byte. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A v4-shaped UUID from a seeded PRNG: what `crypto.randomUUID()` puts on the wire, reproducibly. */
export function seededUuid(rand: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
}
