/**
 * The measurement rig against a known answer (ENGINE-DSP-42).
 *
 * `rig/measure.ts` is the instrument behind the project's sync claim and had no test: it is a script, so
 * this runs it the way a person does — as a process, on WAV files — over a synthetic "room" in which the
 * phones' offsets are chosen here. Nothing is read from `fixtures/` (audio is not committed), so the stem
 * and the recordings are synthesised into a temp directory and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../../rig/wav";

const MEASURE = join(import.meta.dir, "..", "..", "rig", "measure.ts");
const RATE = 44100;
const CLICK_TIMES = Array.from({ length: 12 }, (_, k) => k * 0.5);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A drum-ish stem: the same hit at every click time. `tonal: false` is a broadband hit (2 ms burst, 40 ms
 * of decaying noise — a snare or a hat, and what the synthetic fixture's click is like); `tonal: true` is
 * a kick (2 ms burst, then a decaying 180 Hz sine), whose autocorrelation repeats every 5.6 ms.
 */
function stem(tonal = false): Float32Array {
  const out = new Float32Array(Math.round(6.5 * RATE));
  for (const t of CLICK_TIMES) {
    const rand = rng(77); // the same hit every beat, like a sample being retriggered
    const at = Math.round(t * RATE);
    for (let i = 0; i < Math.round(0.04 * RATE); i++) {
      const sec = i / RATE;
      const burst = i < Math.round(0.002 * RATE) ? (rand() * 2 - 1) * 0.8 : 0;
      const tail = tonal ? Math.sin(2 * Math.PI * 180 * sec) : rand() * 2 - 1;
      out[at + i] = burst + 0.5 * tail * Math.exp(-sec * 90);
    }
  }
  return out;
}

/** The room: 300 ms of lead-in, each phone the same stem shifted by its offset, plus a little noise. */
function room(src: Float32Array, offsetsMs: number[], gains: number[]): Float32Array {
  const lead = Math.round(0.3 * RATE);
  const out = new Float32Array(src.length + lead + RATE / 10);
  const rand = rng(5);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * 0.002;
  offsetsMs.forEach((off, p) => {
    const shift = lead + Math.round((off / 1000) * RATE);
    for (let i = 0; i < src.length; i++) out[i + shift]! += src[i]! * gains[p]! * 0.5;
  });
  return out;
}

let dir = "";
let meta = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-rig-"));
  meta = join(dir, "meta.json"); // native separators: backslashes on Windows, which is the regression
  const src = stem();
  await Bun.write(join(dir, "drums.wav"), encodeWav(src, RATE));
  await Bun.write(meta, JSON.stringify({ id: "rig-test", clickTimesSec: CLICK_TIMES }));
  await Bun.write(join(dir, "two.wav"), encodeWav(room(src, [0, 12], [1, 0.8]), RATE));
  await Bun.write(join(dir, "three.wav"), encodeWav(room(src, [0, 7, 19], [1, 0.9, 0.8]), RATE));
  await Bun.write(join(dir, "quiet.wav"), encodeWav(room(src, [0, 12], [1, 0.2]), RATE));
  await Bun.write(join(dir, "late.wav"), encodeWav(room(src, [0, 40], [1, 1]), RATE));
  // the same room with a kick-like stem, in its own directory (measure.ts finds the stem next to meta.json)
  const kick = stem(true);
  await Bun.write(join(dir, "kick", "drums.wav"), encodeWav(kick, RATE));
  await Bun.write(join(dir, "kick", "meta.json"), JSON.stringify({ id: "rig-test-kick", clickTimesSec: CLICK_TIMES }));
  await Bun.write(join(dir, "kick", "late.wav"), encodeWav(room(kick, [0, 40], [1, 1]), RATE));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function measure(wav: string, ...extra: string[]) {
  const metaPath = wav.startsWith("kick") ? join(dir, "kick", "meta.json") : meta;
  const proc = Bun.spawn([process.execPath, MEASURE, "--wav", join(dir, wav), "--meta", metaPath, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const median = Number(/^\s*median\s+([\d.]+) ms/m.exec(stdout)?.[1] ?? NaN);
  const resolved = Number(/resolved (\d+) of/.exec(stdout)?.[1] ?? NaN);
  return { stdout, stderr, exitCode, median, resolved };
}

describe("rig/measure.ts recovers the offsets it was given", () => {
  test("two phones 12 ms apart, with a native --meta path", async () => {
    const r = await measure("two.wav", "--phones", "2");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0); // 12 ms is MARGINAL, not FAIL
    expect(r.resolved).toBeGreaterThanOrEqual(10);
    expect(Math.abs(r.median - 12)).toBeLessThan(0.1);
    expect(r.stdout).toContain("MARGINAL");
  });

  test("three phones at 0 / 7 / 19 ms: the spread is the outermost pair", async () => {
    const r = await measure("three.wav", "--phones", "3");
    expect(r.exitCode).toBe(0);
    expect(r.resolved).toBeGreaterThanOrEqual(10);
    expect(Math.abs(r.median - 19)).toBeLessThan(0.1);
  });

  test("a phone at one fifth of the level is still found where it was put", async () => {
    // Against the real fixture's drums the default --min-relative 0.55 reports this as INCONCLUSIVE (one
    // peak) and 0.15 recovers it; with this broadband hit both do. Either is honest — a different number
    // would not be.
    for (const extra of [[], ["--min-relative", "0.15"]]) {
      const r = await measure("quiet.wav", "--phones", "2", ...extra);
      expect(r.exitCode).toBe(0);
      expect(r.resolved).toBeGreaterThanOrEqual(10);
      expect(Math.abs(r.median - 12)).toBeLessThan(0.2);
    }
  });

  test("40 ms apart is a FAIL and exits non-zero, so the rig can gate a check", async () => {
    const r = await measure("late.wav", "--phones", "2");
    expect(Math.abs(r.median - 40)).toBeLessThan(0.1);
    expect(r.stdout).toContain("FAIL");
    expect(r.exitCode).toBe(1);
  });

  /*
   * ENGINE-DSP-43 (proposed, not fixed): with a tonal hit the template's own autocorrelation has
   * sidelobes every period of the tone at ~0.8 of the main peak — above the 0.55 `--min-relative` that
   * was tuned on the synthetic fixture — so "the 2 strongest separated peaks" is a main peak and a
   * sidelobe, and the rig prints a spread nobody put there (34.5 ms for phones 40 ms apart). Flip this
   * to `test` once the rig whitens the template / recording or otherwise rejects sidelobes.
   */
  test.failing("a kick-like (tonal) stem: 40 ms apart is still reported as 40 ms", async () => {
    const r = await measure(join("kick", "late.wav"), "--phones", "2");
    expect(Math.abs(r.median - 40)).toBeLessThan(0.5);
  });
});
