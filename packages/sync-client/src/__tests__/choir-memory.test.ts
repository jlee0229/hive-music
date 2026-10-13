/**
 * ENGINE-SYNC-20 (wave 2) · CHOIR memory: one pitched variant, rendered in place, released before the next.
 *
 * Measured with the real engine on a 4-minute 48 kHz song (live heap after a forced GC,
 * `D:\HiveMusic-audit\findings\engine-sync-scripts\choir-mem-bench.ts`):
 *
 *                          before                      after
 *   one mono mix   peak 133 MB, 176 after a     peak 88 MB, 88 after a
 *                  second pitch; 132 held        second pitch; 88 held
 *   four stems     peak 396 / 572 MB             peak 352 / 352 MB; 176 with CHOIR off
 *   one stereo mix peak 176 / 220 MB             peak 132 / 132 MB
 *
 * The decoded song itself is 44 MB per mono stem and has to stay (it is what the phone returns to),
 * so 88 MB is the floor for a pitched single-mix song without re-downloading.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pitchShiftMono } from "../pitch";
import { engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const RATE = 8000;
const SECONDS = 20;

/** A decoded stem that counts render reads and `copyToChannel` calls. */
class Stem extends FakeBuffer {
  static reads = 0;
  override getChannelData(ch: number): Float32Array {
    Stem.reads++;
    return super.getChannelData(ch);
  }
}

async function choirRig(opts: { keepIdleBytes?: number; channels?: number; fill?: (b: Stem) => void } = {}) {
  Stem.reads = 0;
  const originals = new Set<unknown>();
  const r = engineRig(vt, {
    durationSec: SECONDS,
    pitchKeepIdleBytes: opts.keepIdleBytes,
    loadStem: async () => {
      const b = new Stem(SECONDS, RATE);
      b.numberOfChannels = opts.channels ?? 1;
      opts.fill?.(b);
      originals.add(b);
      return b;
    },
  });
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(LOCAL0 + 600) });
  await flushMicrotasks();
  vt.advance(1000);
  // every pitched AudioBuffer the engine asks the context for, with what the engine held at that moment
  const made: Array<{ buffer: FakeBuffer; heldThen: number; copies: number }> = [];
  const create = r.ctx.createBuffer.bind(r.ctx);
  r.ctx.createBuffer = (channels: number, length: number, rate: number) => {
    const buffer = create(channels, length, rate);
    if (length > RATE) {
      const entry = { buffer, heldThen: r.engine.debug.buffersHeld as number, copies: 0 };
      const copy = buffer.copyToChannel.bind(buffer);
      buffer.copyToChannel = (src: Float32Array, ch: number) => {
        entry.copies++;
        copy(src, ch);
      };
      made.push(entry);
    }
    return buffer;
  };
  const choir = (semitones?: number) =>
    r.apply({
      transport: r.playingAt(LOCAL0 + 600),
      assignment: makeAssignment(semitones === undefined ? {} : { pitchSemitones: semitones }),
    });
  const render = async () => vt.advanceAsync(3000, 10);
  return { r, originals, made, choir, render };
}

describe("ENGINE-SYNC-20 · one pitched variant at a time", () => {
  test("the render writes into the AudioBuffer that is played: no second copy of the song", async () => {
    const { r, made, choir, render } = await choirRig();
    choir(12);
    await render();
    expect(made).toHaveLength(STEMS.length);
    expect(made.every((m) => m.copies === 0)).toBe(true); // nothing was copied in afterwards
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    const rendered = new Set<unknown>(made.map((m) => m.buffer));
    expect(live.every((s) => rendered.has(s.buffer))).toBe(true);
  });

  test("a different pitch: the old variant is released before the first buffer of the new one is allocated", async () => {
    const { r, originals, made, choir, render } = await choirRig();
    choir(12);
    await render();
    expect(r.engine.debug.buffersHeld).toBe(3 * STEMS.length); // originals + variant + the scheduler's set
    made.length = 0;

    choir(7);
    await flushMicrotasks();
    // back on the unshifted stems for the length of the render — the +12 copy is gone already
    expect(r.ctx.liveSources(r.ctx.currentTime + 0.08).every((s) => originals.has(s.buffer))).toBe(true);
    await render();
    expect(made).toHaveLength(STEMS.length);
    for (const m of made) expect(m.heldThen).toBe(2 * STEMS.length); // no pitched variant held at any allocation
    expect(r.engine.debug.buffersHeld).toBe(3 * STEMS.length); // and exactly one again afterwards
    expect(r.ctx.liveSources().some((s) => originals.has(s.buffer))).toBe(false);
  });

  test("CHOIR off keeps a small copy (coming back is instant) and releases a big one", async () => {
    const small = await choirRig();
    small.choir(12);
    await small.render();
    small.choir(); // off
    await flushMicrotasks();
    expect(small.r.engine.debug.buffersHeld).toBe(3 * STEMS.length);
    const reads = Stem.reads;
    small.choir(12);
    await flushMicrotasks();
    vt.advance(100);
    expect(Stem.reads).toBe(reads); // no render: the copy was still there
    expect(small.r.ctx.liveSources().some((s) => small.originals.has(s.buffer))).toBe(false);
    small.r.engine.dispose();

    // the same song with the budget set below its size stands in for a four-stem, four-minute track
    const big = await choirRig({ keepIdleBytes: 1024 });
    big.choir(12);
    await big.render();
    expect(big.r.engine.debug.buffersHeld).toBe(3 * STEMS.length);
    big.choir(); // off
    await flushMicrotasks();
    expect(big.r.engine.debug.buffersHeld).toBe(2 * STEMS.length);
    const before = Stem.reads;
    big.choir(12);
    await big.render();
    expect(Stem.reads).toBe(before + STEMS.length); // rendered again on the way back in
  });

  test("a track change releases the variant with the originals", async () => {
    const { r, choir, render } = await choirRig();
    choir(12);
    await render();
    r.apply({ trackId: "song-b", transport: { state: "stopped" }, assignment: makeAssignment({ pitchSemitones: 12 }) });
    expect(r.engine.debug.buffersHeld).toBe(0); // at once, before the next song has even started decoding
  });
});

describe("ENGINE-SYNC-20 · a stereo original is downmixed, not half-dropped", () => {
  test("pitch.ts: [L, R] renders exactly what the mean of L and R renders, with no third copy", async () => {
    const n = RATE * 4;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / RATE);
      right[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE + 1);
    }
    const mean = left.map((v, i) => (v + right[i]!) / 2);
    const fromMean = await pitchShiftMono(mean, 7);
    const fromPair = await pitchShiftMono([left, right], 7);
    expect(fromPair.length).toBe(n);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(fromPair[i]! - fromMean[i]!));
    expect(worst).toBe(0);
  });

  test("pitch.ts: `into` receives the render (bit-identical to an allocated one) and is what comes back", async () => {
    const n = RATE * 4;
    const input = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 180 * i) / RATE));
    for (const semitones of [12, -12, 7]) {
      const plain = await pitchShiftMono(input, semitones);
      const into = new Float32Array(n).fill(123); // stale contents must not survive
      const out = await pitchShiftMono(input, semitones, { into });
      expect(out).toBe(into);
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(out[i]! - plain[i]!));
      expect(worst).toBe(0);
    }
    await expect(pitchShiftMono(input, 12, { into: new Float32Array(n - 1) })).rejects.toThrow(RangeError);
  });

  test("engine: a song that lives only in the right channel is still heard in CHOIR", async () => {
    const { made, choir, render } = await choirRig({
      channels: 2,
      fill: (b) => {
        const rightOnly = FakeBuffer.prototype.getChannelData.call(b, 1);
        for (let i = 0; i < rightOnly.length; i++) rightOnly[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / RATE);
      },
    });
    choir(12);
    await render();
    expect(made).toHaveLength(STEMS.length);
    for (const m of made) {
      const x = m.buffer.getChannelData(0);
      let energy = 0;
      for (let i = RATE; i < x.length - RATE; i++) energy += x[i]! * x[i]!;
      const rms = Math.sqrt(energy / (x.length - 2 * RATE));
      // half-level (the mean with a silent left channel) of a 0.5-amplitude sine is ~0.18 RMS
      expect(rms).toBeGreaterThan(0.1);
    }
  });
});
