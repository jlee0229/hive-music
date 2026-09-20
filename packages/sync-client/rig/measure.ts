#!/usr/bin/env bun
/**
 * The measurement rig: how the ≤10 ms claim is actually checked, as opposed to asserted.
 *
 * Two or more phones play `synthetic-60s` in UNISON. A laptop or a spare phone records the room. Every
 * phone plays the same click train (one per beat, `clickTimesSec` in meta.json), so each click window in
 * the recording contains one peak per phone, and the *spread between those peaks is the
 * device-to-device skew*. No shared clock is involved on the measurement side at all, which is the point:
 * the instrument cannot inherit the error it is measuring.
 *
 *   bun packages/sync-client/rig/measure.ts --wav recording.wav [--meta fixtures/tracks/synthetic-60s/meta.json]
 *                                          [--phones 2] [--from 0] [--to 30] [--window 100] [--stem drums]
 *                                          [--click] [--json out.json]
 *
 * Reads:
 *   --wav      the recording (16/24/32-bit PCM or 32-bit float, any channel count)
 *   --meta     the track's meta.json, for clickTimesSec (default: fixtures/tracks/synthetic-60s)
 *   --phones   how many peaks to look for per click (default 2)
 *   --from/-to seconds of the recording to analyse (default: all of it)
 *   --window   half-width of the search window around each expected click, ms (default 100)
 *   --stem     which stem's click to use as the template (default drums)
 *   --click    use the calibration click (DEFAULT_CLICK_SPEC) as the template instead of the stem's
 *   --min-strength  ignore peaks weaker than this normalised correlation (default 0.15)
 *   --min-relative  a peak counts as another phone only if it is at least this fraction of the strongest
 *                   peak in its window (default 0.55). See the note on sidelobes below.
 *
 * Prints per click the peak offsets and their spread, then mean/median/sd/p95 of the spread, and exits
 * non-zero if the median spread exceeds SYNC_TARGET_MS — so it can gate a check rather than just inform.
 *
 * Attributing a peak to a *particular* phone needs one more step: nudge one phone by a known amount
 * (that is the B4 "+40 ms → 40±3 ms" check) or pin the others to non-drum roles in ORCHESTRA.
 */
import { DEFAULT_CLICK_SPEC, SYNC_TARGET_MS, SYNC_FLOOR_MS } from "@hive/protocol";
import { renderClick } from "../src/calibration/click";
import { findPeaks, median, normalizeEnergy, resample } from "../src/calibration/xcorr";
import { readWav } from "./wav";

interface Args {
  wav: string;
  meta: string;
  phones: number;
  from: number;
  to: number;
  windowMs: number;
  stem: string;
  useClick: boolean;
  minStrength: number;
  minRelative: number;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const wav = get("wav");
  if (!wav) {
    console.error("usage: bun packages/sync-client/rig/measure.ts --wav recording.wav [--phones 2] [--from 0] [--to 30]");
    process.exit(2);
  }
  return {
    wav,
    meta: get("meta") ?? `${import.meta.dir}/../../../fixtures/tracks/synthetic-60s/meta.json`,
    phones: Number(get("phones") ?? 2),
    from: Number(get("from") ?? 0),
    to: Number(get("to") ?? Infinity),
    windowMs: Number(get("window") ?? 100),
    stem: get("stem") ?? "drums",
    useClick: has("click"),
    minStrength: Number(get("min-strength") ?? 0.15),
    minRelative: Number(get("min-relative") ?? 0.55),
    json: get("json") ?? null,
  };
}

/**
 * The template. For a music recording it is cut out of the stem itself at the first click, so it is
 * exactly the waveform the phones emitted — including whatever the fixture generator did to it. For a
 * calibration-click recording, `--click` synthesises `DEFAULT_CLICK_SPEC` instead.
 */
async function buildTemplate(args: Args, meta: { id: string; clickTimesSec?: number[] }, rate: number) {
  if (args.useClick) {
    return { template: renderClick(DEFAULT_CLICK_SPEC, rate), source: "DEFAULT_CLICK_SPEC" };
  }
  const stemPath = `${args.meta.replace(/\/meta\.json$/, "")}/${args.stem}.wav`;
  const stem = await readWav(stemPath);
  const firstClick = meta.clickTimesSec?.[0] ?? 0;
  const lengthSec = 0.05; // the fixture's click is a 2 ms burst plus a ~40 ms tail
  const start = Math.round(firstClick * stem.sampleRate);
  const cut = stem.samples.slice(start, start + Math.round(lengthSec * stem.sampleRate));
  if (cut.length === 0) throw new Error(`could not cut a template from ${stemPath}`);
  return { template: resample(cut, stem.sampleRate, rate), source: `${args.stem}.wav @ ${firstClick}s` };
}

const stats = (xs: number[]) => {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, sd: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return {
    n: xs.length,
    mean,
    median: median(xs),
    sd,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    max: sorted[sorted.length - 1]!,
  };
};

const args = parseArgs(process.argv.slice(2));
const meta = (await Bun.file(args.meta).json()) as { id: string; clickTimesSec?: number[]; bpm?: number };
const rec = await readWav(args.wav);
const { template, source } = await buildTemplate(args, meta, rec.sampleRate);
const normTemplate = normalizeEnergy(template);
const perMs = rec.sampleRate / 1000;

/*
 * A click whose ±window would run past the end of the file cannot be measured: the correlation would be
 * computed against a truncated window and return a confident-looking peak in the wrong place. Drop those
 * rather than reporting them — a recording that stops mid-song is normal.
 */
const templateSec = template.length / rec.sampleRate;
const lastUsableSec = rec.durationSec - (args.windowMs / 1000 + templateSec);
const clickTimes = (meta.clickTimesSec ?? []).filter(
  (t) => t >= args.from && t <= Math.min(args.to, lastUsableSec),
);
if (clickTimes.length === 0) {
  console.error(`no clicks from meta.json inside [${args.from}, ${args.to}] of a ${rec.durationSec.toFixed(1)} s recording`);
  process.exit(2);
}

console.log(`# HiveMusic rig · ${args.wav}`);
console.log(`recording : ${rec.durationSec.toFixed(2)} s, ${rec.sampleRate} Hz, ${rec.channels} ch`);
console.log(`template  : ${source}, ${template.length} samples (${((template.length / rec.sampleRate) * 1000).toFixed(1)} ms)`);
console.log(`clicks    : ${clickTimes.length} in [${args.from}, ${Math.min(args.to, rec.durationSec).toFixed(1)}] s, looking for ${args.phones} phones each`);
console.log(`window    : ±${args.windowMs} ms\n`);

/*
 * The recording's own start is unknown: nobody pressed record on the shared clock. So the first click is
 * used to find it — its strongest peak defines "where the click train actually begins in this file", and
 * every later window is placed relative to that. An error here shifts every window equally and cannot
 * affect a *spread*, which is what we report.
 */
const anchorWindow = findPeaks(rec.samples, normTemplate, {
  fromSample: Math.max(0, (clickTimes[0]! * 1000 - 1000) * perMs),
  toSample: (clickTimes[0]! * 1000 + 1000) * perMs,
  sampleRate: rec.sampleRate,
  count: 1,
  minSeparationMs: 1,
});
if (anchorWindow.length === 0) {
  console.error("could not find the first click: is this a recording of the right track?");
  process.exit(1);
}
const offsetMs = anchorWindow[0]!.lagSamples / perMs - clickTimes[0]! * 1000;
console.log(`anchor    : first click found at ${(anchorWindow[0]!.lagSamples / perMs / 1000).toFixed(3)} s → recording starts ${(-offsetMs / 1000).toFixed(3)} s before track zero\n`);

console.log("  t(s)    peaks at (ms, relative to the click)      spread   strength");
console.log("  ------  ------------------------------------------  -------  --------");

const spreads: number[] = [];
let skipped = 0;
let merged = 0;
const rows: Array<{ trackSec: number; peaksMs: number[]; spreadMs: number; strength: number[] }> = [];

for (const t of clickTimes) {
  const expectedMs = t * 1000 + offsetMs;
  const peaks = findPeaks(rec.samples, normTemplate, {
    fromSample: (expectedMs - args.windowMs) * perMs,
    toSample: (expectedMs + args.windowMs) * perMs,
    sampleRate: rec.sampleRate,
    count: args.phones,
    minSeparationMs: 1,
  });
  /*
   * Two filters, and the second one is the difference between an instrument and a random number
   * generator.
   *
   * `--min-strength` drops noise wearing a click's shape. `--min-relative` drops *sidelobes of the click
   * we already found*: a drum hit correlated against itself has secondary maxima a millisecond or two
   * away, and asking for "the 2 strongest separated peaks" happily returns one of them as a second
   * phone. Measured on synthetic recordings where the truth is known (rig/synth-recording.ts): a real
   * second phone's peak is ~75 % as strong as the first, a sidelobe is ≤46 %. 0.55 separates them.
   *
   * The cost is that a genuinely much quieter phone (further away, lower volume) can fall below the
   * ratio and be reported as absent. If a phone you can hear is not showing up, lower this and check the
   * offsets it produces are stable across clicks — a real phone's offset repeats, a sidelobe's wanders.
   */
  const strongest = Math.max(...peaks.map((p) => p.value));
  const strong = peaks.filter((p) => p.value >= args.minStrength && p.value >= strongest * args.minRelative);
  if (strong.length === 0) {
    skipped++;
    continue;
  }
  const peaksMs = strong.map((p) => p.lagSamples / perMs - expectedMs).sort((a, b) => a - b);
  const spreadMs = peaksMs.length > 1 ? peaksMs[peaksMs.length - 1]! - peaksMs[0]! : 0;
  if (strong.length >= Math.min(2, args.phones)) spreads.push(spreadMs);
  else merged++;
  rows.push({ trackSec: t, peaksMs, spreadMs, strength: strong.map((p) => p.value) });

  const list = peaksMs.map((v) => (v >= 0 ? "+" : "") + v.toFixed(2)).join("  ").padEnd(42);
  const flag = spreadMs > SYNC_FLOOR_MS ? " !!" : spreadMs > SYNC_TARGET_MS ? " !" : "  ";
  console.log(
    `  ${t.toFixed(2).padStart(6)}  ${list}  ${spreadMs.toFixed(2).padStart(6)}${flag}  ` +
      strong.map((p) => p.value.toFixed(2)).join(" "),
  );
}

const s = stats(spreads);
console.log(`\n# device-to-device spread`);
console.log(`  resolved ${s.n} of ${clickTimes.length} clicks into ${args.phones} peaks`);
if (merged > 0) console.log(`  merged   ${merged} clicks into one peak (phones within the ~1 ms resolution floor, or one is much quieter)`);
if (skipped > 0) console.log(`  unheard  ${skipped} clicks (every peak below --min-strength ${args.minStrength})`);
if (s.n > 0) {
  console.log(`  mean     ${s.mean.toFixed(2)} ms`);
  console.log(`  median   ${s.median.toFixed(2)} ms`);
  console.log(`  sd       ${s.sd.toFixed(2)} ms`);
  console.log(`  p95      ${s.p95.toFixed(2)} ms`);
  console.log(`  max      ${s.max.toFixed(2)} ms`);
}
console.log(`\n  target ${SYNC_TARGET_MS} ms · floor ${SYNC_FLOOR_MS} ms`);

if (args.json) {
  await Bun.write(args.json, JSON.stringify({ wav: args.wav, template: source, offsetMs, stats: s, rows }, null, 2));
  console.log(`\n  wrote ${args.json}`);
}

/*
 * The verdict, and the one case worth calling out rather than scoring. If most windows collapsed into a
 * single peak there is nothing to take a median of — and that is usually GOOD news (the phones are inside
 * the rig's resolution floor), but it is not a measurement and must not be printed as one. The way to turn
 * it into a measurement is the B4 trick: nudge one phone by a known amount, confirm the rig sees exactly
 * that, and you know both that the phones were together and that the instrument is honest.
 */
const enough = s.n >= 3;
const verdict = !enough
  ? "INCONCLUSIVE"
  : s.median <= SYNC_TARGET_MS
    ? "PASS"
    : s.median <= SYNC_FLOOR_MS
      ? "MARGINAL"
      : "FAIL";
if (enough) {
  console.log(`\n  ${verdict} (median spread vs the ${SYNC_TARGET_MS} ms target)`);
} else if (merged >= clickTimes.length / 2) {
  console.log(
    `\n  ${verdict}: ${merged} of ${clickTimes.length} clicks resolved a single peak, so there is no spread to` +
      `\n  measure. Most likely the phones are within ~1 ms of each other. To confirm it rather than assume` +
      `\n  it: nudge one phone by +40 ms and re-run — the rig should report 40 ms.`,
  );
} else {
  console.log(`\n  ${verdict}: only ${s.n} clicks resolved ${args.phones} peaks. Check --min-strength / --min-relative.`);
}
/*
 * A note on reading this output. Peaks closer than ~1 ms merge into one, so a single peak per window
 * where you expected two means the phones are in sync, not that a phone is missing — check `strength`
 * and the count. A spread that is stable across the whole recording is output latency (fix it with the
 * nudge or with Tier-2 calibration); a spread that grows with time is clock or audio-clock drift (that
 * is what B4's resync is for, and a rig run at t=0 and t=5 min is how you tell the two apart).
 */
process.exit(verdict === "FAIL" ? 1 : 0);
