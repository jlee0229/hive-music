/**
 * B8e: the matched filter, against synthetic recordings with known answers.
 *
 * This is the one piece of DSP in the project, and it is the instrument the sync numbers are measured
 * with — so it is tested against recordings where the truth is known to the sample, including the ways a
 * real room degrades the signal: pink noise, a quiet phone, a band-limited speaker, and a click that was
 * never heard at all.
 */
import { describe, expect, test } from "bun:test";
import { CALIBRATION_CLICK_INTERVAL_MS, DEFAULT_CLICK_SPEC } from "@hive/protocol";
import { renderClick } from "../calibration/click";
import { analyzeClicks, findPeak, median, normalizeEnergy } from "../calibration/xcorr";

const RATE = 48000;
const template = renderClick(DEFAULT_CLICK_SPEC, RATE);

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pink-ish noise: white through a one-pole low-pass, which is what a room actually sounds like. */
function pinkNoise(length: number, amplitude: number, seed = 5): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(length);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = rand() * 2 - 1;
    last = 0.96 * last + 0.04 * white;
    out[i] = last * amplitude * 8; // the filter loses most of the energy; scale it back up
  }
  return out;
}

interface Placement {
  atMs: number;
  gain?: number;
  /** Crude speaker/mic colouring: a one-pole smear of the click before it is mixed in. */
  smear?: boolean;
}

/** Builds a fake recording: noise plus the template at each placement. */
function recordingWith(placements: Placement[], lengthMs: number, noise = 0.02, seed = 5): Float32Array {
  const out = pinkNoise(Math.round((lengthMs / 1000) * RATE), noise, seed);
  for (const p of placements) {
    const start = Math.round((p.atMs / 1000) * RATE);
    const gain = p.gain ?? 1;
    let smeared = template;
    if (p.smear) {
      smeared = new Float32Array(template.length);
      let last = 0;
      for (let i = 0; i < template.length; i++) {
        last = 0.7 * last + 0.3 * template[i]!;
        smeared[i] = last;
      }
    }
    for (let i = 0; i < smeared.length; i++) {
      const at = start + i;
      if (at >= 0 && at < out.length) out[at]! += smeared[i]! * gain;
    }
  }
  return out;
}

describe("findPeak", () => {
  test("locates a template delayed by 23.4 ms to well inside 1 ms", () => {
    // The gate's number. One sample at 48 kHz is 0.021 ms, so "within 1 ms" should be easy — and if it
    // is not, something is wrong with the normalisation rather than the resolution.
    const recording = recordingWith([{ atMs: 23.4 }], 300);
    const peak = findPeak(normalizeEnergy(recording), normalizeEnergy(template), {
      fromSample: 0,
      toSample: 200 * (RATE / 1000),
      sampleRate: RATE,
    });
    const foundMs = peak.lagSamples / (RATE / 1000);
    expect(Math.abs(foundMs - 23.4)).toBeLessThan(1);
    expect(Math.abs(foundMs - 23.4)).toBeLessThan(0.1); // and in fact far better
    expect(peak.confidence).toBeGreaterThan(0.8);
    console.log(`[B8] single click at 23.4 ms → found at ${foundMs.toFixed(3)} ms (err ${(foundMs - 23.4).toFixed(3)} ms, confidence ${peak.confidence.toFixed(2)})`);
  });

  test("two clicks 300 ms apart are resolved independently", () => {
    const recording = recordingWith([{ atMs: 100 }, { atMs: 400 }], 700);
    const first = findPeak(recording, normalizeEnergy(template), {
      fromSample: 0 * (RATE / 1000),
      toSample: 250 * (RATE / 1000),
      sampleRate: RATE,
    });
    const second = findPeak(recording, normalizeEnergy(template), {
      fromSample: 250 * (RATE / 1000),
      toSample: 550 * (RATE / 1000),
      sampleRate: RATE,
    });
    expect(Math.abs(first.lagSamples / (RATE / 1000) - 100)).toBeLessThan(0.5);
    expect(Math.abs(second.lagSamples / (RATE / 1000) - 400)).toBeLessThan(0.5);
    expect(first.confidence).toBeGreaterThan(0.8);
    expect(second.confidence).toBeGreaterThan(0.8);
  });

  test("a quiet phone is found as accurately as a loud one, which is what the normalisation buys", () => {
    for (const gain of [1, 0.3, 0.1]) {
      const recording = recordingWith([{ atMs: 50 }], 300, 0.02, 11);
      const scaled = new Float32Array(recording.length);
      // scale only the click, not the noise: a distant phone against the same room
      const quiet = recordingWith([{ atMs: 50, gain }], 300, 0.02, 11);
      for (let i = 0; i < scaled.length; i++) scaled[i] = quiet[i]!;
      const peak = findPeak(scaled, normalizeEnergy(template), {
        fromSample: 0,
        toSample: 200 * (RATE / 1000),
        sampleRate: RATE,
      });
      const err = Math.abs(peak.lagSamples / (RATE / 1000) - 50);
      expect(err).toBeLessThan(1);
    }
  });

  test("a band-limited, smeared click still lands within a millisecond", () => {
    // A phone speaker is not flat and a phone mic is not either; the chirp is what keeps the peak sharp.
    const recording = recordingWith([{ atMs: 77.5, smear: true }], 300);
    const peak = findPeak(recording, normalizeEnergy(template), {
      fromSample: 0,
      toSample: 200 * (RATE / 1000),
      sampleRate: RATE,
    });
    const err = peak.lagSamples / (RATE / 1000) - 77.5;
    expect(Math.abs(err)).toBeLessThan(1);
    console.log(`[B8] smeared (band-limited) click at 77.5 ms → err ${err.toFixed(3)} ms, confidence ${peak.confidence.toFixed(2)}`);
  });

  test("noise alone produces low confidence rather than a confident wrong answer", () => {
    const recording = pinkNoise(Math.round(0.3 * RATE), 0.05, 99);
    const peak = findPeak(recording, normalizeEnergy(template), {
      fromSample: 0,
      toSample: 200 * (RATE / 1000),
      sampleRate: RATE,
    });
    expect(peak.confidence).toBeLessThan(0.5);
    console.log(`[B8] noise with no click → confidence ${peak.confidence.toFixed(3)} (below the 0.5 cutoff, so the server ignores it)`);
  });
});

describe("analyzeClicks: residuals", () => {
  const INTERVAL = CALIBRATION_CLICK_INTERVAL_MS; // 400

  test("six phones, one 7.3 ms late: that residual is right and the others are ~0", () => {
    // The acceptance case from docs/04. `offset` is the reference's own constant latency, which every
    // click shares and the median removes — it is deliberately large here to prove that.
    const offset = 37.2;
    const lateIndex = 3;
    const placements = Array.from({ length: 6 }, (_, k) => ({
      atMs: offset + k * INTERVAL + (k === lateIndex ? 7.3 : 0),
    }));
    const recording = recordingWith(placements, 6 * INTERVAL + 400);

    const result = analyzeClicks({
      recording,
      sampleRate: RATE,
      template,
      expectedMs: Array.from({ length: 6 }, (_, k) => k * INTERVAL),
    });

    expect(result.anchorCount).toBe(6);
    expect(result.medianRawMs).toBeCloseTo(offset, 0); // the common constant, recovered
    for (const c of result.clicks) {
      const expected = c.index === lateIndex ? 7.3 : 0;
      expect(Math.abs(c.residualMs - expected)).toBeLessThan(1);
      expect(c.confidence).toBeGreaterThan(0.8);
    }
    const worst = Math.max(...result.clicks.map((c) => Math.abs(c.residualMs - (c.index === lateIndex ? 7.3 : 0))));
    console.log(
      `[B8] 6 clicks, #${lateIndex} late by 7.3 ms, reference latency ${offset} ms: ` +
        `median ${result.medianRawMs.toFixed(2)} ms removed, worst residual error ${worst.toFixed(3)} ms`,
    );
  });

  test("the reference's own latency cancels exactly, whatever it is", () => {
    const residualsFor = (offset: number) => {
      const placements = Array.from({ length: 4 }, (_, k) => ({ atMs: offset + k * INTERVAL + (k === 1 ? 12 : 0) }));
      const recording = recordingWith(placements, 4 * INTERVAL + 400);
      return analyzeClicks({
        recording,
        sampleRate: RATE,
        template,
        expectedMs: Array.from({ length: 4 }, (_, k) => k * INTERVAL),
      }).clicks.map((c) => c.residualMs);
    };
    const a = residualsFor(10);
    const b = residualsFor(90);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(0.5);
    expect(Math.abs(a[1]! - 12)).toBeLessThan(1);
  });

  test("a click that was never heard gets low confidence and does not move the others", () => {
    const missing = 2;
    const placements = Array.from({ length: 5 }, (_, k) => ({ atMs: 20 + k * INTERVAL }))
      .filter((_, k) => k !== missing);
    const recording = recordingWith(placements, 5 * INTERVAL + 400);

    const result = analyzeClicks({
      recording,
      sampleRate: RATE,
      template,
      expectedMs: Array.from({ length: 5 }, (_, k) => k * INTERVAL),
    });

    expect(result.clicks[missing]!.confidence).toBeLessThan(0.5);
    expect(result.anchorCount).toBe(4); // the missing one did not anchor the median
    for (const c of result.clicks) {
      if (c.index === missing) continue;
      expect(Math.abs(c.residualMs)).toBeLessThan(1);
      expect(c.confidence).toBeGreaterThan(0.8);
    }
  });

  test("a single phone has a residual of 0 by construction", () => {
    const recording = recordingWith([{ atMs: 63.5 }], 500);
    const result = analyzeClicks({ recording, sampleRate: RATE, template, expectedMs: [0] });
    expect(result.clicks[0]!.residualMs).toBeCloseTo(0, 9);
    expect(Math.abs(result.medianRawMs - 63.5)).toBeLessThan(1);
  });

  test("the window never reaches a neighbouring click", () => {
    // ±150 ms against a 400 ms interval: even a phone 100 ms out cannot be confused with its neighbour.
    const placements = [{ atMs: 0 }, { atMs: INTERVAL + 100 }];
    const recording = recordingWith(placements, 2 * INTERVAL + 400);
    const result = analyzeClicks({
      recording,
      sampleRate: RATE,
      template,
      expectedMs: [0, INTERVAL],
    });
    expect(Math.abs(result.clicks[1]!.rawMs - 100)).toBeLessThan(1);
    expect(result.clicks[1]!.confidence).toBeGreaterThan(0.5);
  });

  test("at 44.1 kHz as well as 48 kHz", () => {
    const rate = 44100;
    const t = renderClick(DEFAULT_CLICK_SPEC, rate);
    const length = Math.round(0.5 * rate);
    const out = new Float32Array(length);
    const start = Math.round((31.7 / 1000) * rate);
    for (let i = 0; i < t.length; i++) out[start + i] = t[i]!;
    const peak = findPeak(out, normalizeEnergy(t), { fromSample: 0, toSample: length - t.length, sampleRate: rate });
    expect(Math.abs(peak.lagSamples / (rate / 1000) - 31.7)).toBeLessThan(0.1);
  });
});

describe("helpers", () => {
  test("median handles both parities and an empty list", () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("normalizeEnergy gives unit energy and tolerates silence", () => {
    const norm = normalizeEnergy(new Float32Array([1, 2, 3]));
    let energy = 0;
    for (const v of norm) energy += v * v;
    expect(energy).toBeCloseTo(1, 6);
    expect([...normalizeEnergy(new Float32Array(4))]).toEqual([0, 0, 0, 0]);
  });
});
