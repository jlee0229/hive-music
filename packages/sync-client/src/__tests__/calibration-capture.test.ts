/**
 * ENGINE-DSP-44: the capture is laid out on the audio context's timeline, not concatenated.
 *
 * `expectedMs` for click k is "plan time minus the recording's start", which is only true if sample i of
 * the recording was captured i frames after the first one. A hole in the capture breaks that for every
 * later click, and because all of them still look perfect to the matched filter, the error arrives at
 * the server as confident residuals.
 */
import { describe, expect, test } from "bun:test";
import { CALIBRATION_CLICK_INTERVAL_MS, DEFAULT_CLICK_SPEC } from "@hive/protocol";
import { renderClick } from "../calibration/click";
import { assembleCapture, MAX_CAPTURE_GAP_FRAMES, type CapturedChunk } from "../calibration/reference";
import { analyzeClicks } from "../calibration/xcorr";

const RATE = 48000;
const PER_MS = RATE / 1000;
const QUANTUM = 128;
const template = renderClick(DEFAULT_CLICK_SPEC, RATE);

/** Six phones, all exactly in sync, 20 ms of reference latency, a little deterministic room noise. */
const PHONES = 6;
const expectedMs = Array.from({ length: PHONES }, (_, k) => 200 + k * CALIBRATION_CLICK_INTERVAL_MS);
function room(): Float32Array {
  const out = new Float32Array(Math.round((PHONES * CALIBRATION_CLICK_INTERVAL_MS + 600) * PER_MS));
  let a = 12345;
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    a = (Math.imul(a, 1103515245) + 12345) & 0x7fffffff;
    last = 0.96 * last + 0.04 * ((a / 0x7fffffff) * 2 - 1);
    out[i] = last * 0.05;
  }
  for (const e of expectedMs) {
    const start = Math.round((e + 20) * PER_MS);
    for (let i = 0; i < template.length; i++) out[start + i]! += template[i]! * 0.5;
  }
  return out;
}

/** Cuts the room into render quanta, as the worklet posts them, optionally losing some. */
function capture(signal: Float32Array, opts: { dropFromMs?: number; dropMs?: number; stamped: boolean }): CapturedChunk[] {
  const dropFrom = opts.dropFromMs == null ? Infinity : Math.round(opts.dropFromMs * PER_MS);
  const dropTo = dropFrom + Math.round((opts.dropMs ?? 0) * PER_MS);
  const chunks: CapturedChunk[] = [];
  for (let at = 0; at + QUANTUM <= signal.length; at += QUANTUM) {
    if (at >= dropFrom && at < dropTo) continue; // the graph handed us no input for this quantum
    chunks.push({ samples: signal.slice(at, at + QUANTUM), at: opts.stamped ? at : null });
  }
  return chunks;
}

const residuals = (recording: Float32Array) =>
  analyzeClicks({ recording, sampleRate: RATE, template, expectedMs }).clicks;

describe("assembleCapture", () => {
  test("contiguous blocks are a plain concatenation, stamped or not", () => {
    const signal = room();
    const whole = signal.subarray(0, Math.floor(signal.length / QUANTUM) * QUANTUM);
    expect(assembleCapture(capture(signal, { stamped: true }))).toEqual(new Float32Array(whole));
    expect(assembleCapture(capture(signal, { stamped: false }))).toEqual(new Float32Array(whole));
  });

  test("16 ms lost mid-run: unstamped, phones in perfect sync get confident ±8 ms residuals", () => {
    // What the code did before, kept as the statement of the bug: six render quanta (768 frames, 16 ms)
    // go missing after the third click, so three phones read 16 ms early relative to the other three.
    const dropFromMs = expectedMs[2]! + 200;
    const clicks = residuals(assembleCapture(capture(room(), { dropFromMs, dropMs: 16, stamped: false })));
    for (const c of clicks) {
      expect(c.confidence).toBeGreaterThan(0.8); // every one of these would be applied and accumulated
      expect(Math.abs(Math.abs(c.residualMs) - 8)).toBeLessThan(0.2);
    }
  });

  test("16 ms lost mid-run: stamped, the hole is silence and every residual stays ~0", () => {
    const dropFromMs = expectedMs[2]! + 200;
    const signal = room();
    const recording = assembleCapture(capture(signal, { dropFromMs, dropMs: 16, stamped: true }));
    expect(recording.length).toBe(Math.floor(signal.length / QUANTUM) * QUANTUM);
    for (const c of residuals(recording)) {
      expect(c.confidence).toBeGreaterThan(0.8);
      expect(Math.abs(c.residualMs)).toBeLessThan(0.1);
    }
  });

  test("a hole right after the first click no longer moves five phones against one", () => {
    const dropFromMs = expectedMs[0]! + 200;
    const clicks = residuals(assembleCapture(capture(room(), { dropFromMs, dropMs: 85, stamped: true })));
    for (const c of clicks) expect(Math.abs(c.residualMs)).toBeLessThan(0.1);
  });

  test("a stamp behind the cursor appends: captured audio is never overwritten", () => {
    const a = new Float32Array(QUANTUM).fill(1);
    const b = new Float32Array(QUANTUM).fill(2);
    const out = assembleCapture([{ samples: a, at: 0 }, { samples: b, at: 64 }]);
    expect(out.length).toBe(2 * QUANTUM);
    expect(out[QUANTUM - 1]).toBe(1);
    expect(out[QUANTUM]).toBe(2);
  });

  test("an absurd or non-finite stamp cannot allocate without bound", () => {
    const a = new Float32Array(QUANTUM).fill(1);
    const far = assembleCapture([{ samples: a, at: 0 }, { samples: a, at: 1e12 }, { samples: a, at: 2e12 }]);
    expect(far.length).toBe(3 * QUANTUM + MAX_CAPTURE_GAP_FRAMES);
    expect(assembleCapture([{ samples: a, at: NaN }, { samples: a, at: Infinity }]).length).toBe(2 * QUANTUM);
    expect(assembleCapture([]).length).toBe(0);
  });
});
