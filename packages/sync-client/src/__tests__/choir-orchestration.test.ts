/**
 * ENGINE-SYNC-15 · CHOIR: the orchestration around the pitch render (the DSP itself is engine-dsp's).
 *
 * The render is seconds of main-thread work per stem on a phone. Two things made it worse than it had to
 * be: a render that threw was started again by the next snapshot, and the next, for the rest of the
 * song; and an assignment that moved while one render was in flight started a second render beside it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

/** A decoded stem that counts how often a render reads it (each render reads each stem once). */
class CountingBuffer extends FakeBuffer {
  static reads = 0;
  static failing = false;
  override getChannelData(ch: number): Float32Array {
    CountingBuffer.reads++;
    if (CountingBuffer.failing) throw new RangeError("Array buffer allocation failed");
    return super.getChannelData(ch);
  }
}

async function playingRig(durationSec = 20) {
  CountingBuffer.reads = 0;
  CountingBuffer.failing = false;
  const originals = new Set<unknown>();
  const r = engineRig(vt, {
    durationSec,
    loadStem: async () => {
      const b = new CountingBuffer(durationSec, 8000);
      originals.add(b);
      return b;
    },
  });
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(LOCAL0 + 600) });
  await flushMicrotasks();
  vt.advance(2000);
  const choir = (semitones: number) =>
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: makeAssignment({ pitchSemitones: semitones }) });
  return { r, originals, choir };
}

describe("ENGINE-SYNC-15 · CHOIR render orchestration", () => {
  test("a render that throws is attempted once, not once per snapshot, and the phone keeps playing", async () => {
    const { r, originals, choir } = await playingRig();
    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      CountingBuffer.failing = true;
      for (let i = 0; i < 20; i++) {
        choir(12); // the same assignment, as every later snapshot carries it
        await vt.advanceAsync(500, 50);
      }
    } finally {
      console.warn = warn;
    }
    expect(CountingBuffer.reads).toBe(1);
    expect(warnings).toHaveLength(1); // said once, where a developer will see it
    expect(r.errors).toHaveLength(0); // and not as an `error` event: the host screen toasts those verbatim
    // still sounding, on the unshifted stems
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    expect(live.every((s) => originals.has(s.buffer))).toBe(true);
  });

  test("a new track gets a fresh attempt", async () => {
    const { r, choir } = await playingRig();
    const warn = console.warn;
    console.warn = () => {};
    try {
      CountingBuffer.failing = true;
      choir(12);
      await vt.advanceAsync(500, 50);
      expect(CountingBuffer.reads).toBe(1);
      CountingBuffer.failing = false;
      CountingBuffer.reads = 0;
      r.apply({ trackId: "song-b", transport: r.playingAt(r.localMs() + 600), assignment: makeAssignment({ pitchSemitones: 12 }) });
      await vt.advanceAsync(3000, 10);
    } finally {
      console.warn = warn;
    }
    expect(CountingBuffer.reads).toBe(STEMS.length);
  });

  test("an assignment that flips while a render is in flight does not start renders side by side", async () => {
    // 60 s of audio: long enough that the render yields to the event loop part-way through a stem, so it
    // is genuinely still in flight when the assignment moves.
    const { r, originals, choir } = await playingRig(60);
    // ten changes inside the first render (nothing below lets the render's own timers run)
    for (let i = 0; i < 10; i++) choir(i % 2 ? 7 : 12);
    await flushMicrotasks();
    expect(CountingBuffer.reads).toBe(1); // one render started, on its first stem — not ten

    await vt.advanceAsync(6000, 10);
    // each variant was rendered at most once (4 stems each), and the one wanted last is what is playing
    expect(CountingBuffer.reads).toBeLessThanOrEqual(2 * STEMS.length);
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    expect(live.some((s) => originals.has(s.buffer))).toBe(false);
    // 4 originals + two cached variants + the scheduler's 4
    expect(r.engine.debug.buffersHeld).toBeLessThanOrEqual(4 * STEMS.length);
  });
});

/**
 * ENGINE-SYNC-19 (wave 2) · a render nobody wants any more is cancelled, not run to the end of its stem.
 *
 * pitch.ts takes an abort signal and polls it between slices (0.37 s of audio at 44.1 kHz). audio.ts owns
 * the render's lifecycle: it raises the signal when the track changes, when the assignment asks for a
 * different pitch, and on dispose. `counters.pitchYields` counts finished slices, so "the render stopped"
 * is "the count stopped".
 */
describe("ENGINE-SYNC-19 · stale CHOIR renders are aborted", () => {
  /** A render in flight on a 60 s track: a few slices in, most of the first stem still to go. */
  async function midRender() {
    const rig = await playingRig(60);
    rig.choir(12);
    await vt.advanceAsync(50, 10);
    expect(rig.r.engine.debug.pitchRendering).toBe(true);
    expect(rig.r.counters.pitchYields).toBeGreaterThan(2);
    expect(CountingBuffer.reads).toBe(1);
    return rig;
  }

  test("a track change stops it within one slice, and the new track is rendered instead", async () => {
    const { r } = await midRender();
    const before = r.counters.pitchYields;
    CountingBuffer.reads = 0;
    r.apply({ trackId: "song-b", transport: r.playingAt(r.localMs() + 600), assignment: makeAssignment({ pitchSemitones: 12 }) });
    await flushMicrotasks(); // song-b decodes at once in this rig; the old render has not yielded again yet
    await vt.advanceAsync(10, 10); // one more slice of the old render is allowed to finish
    const afterAbort = r.counters.pitchYields;
    expect(afterAbort - before).toBeLessThanOrEqual(2);

    await vt.advanceAsync(8000, 10);
    // only song-b's four stems were read for rendering — the old track's remaining three never were
    expect(CountingBuffer.reads).toBe(STEMS.length);
    expect(r.engine.debug.pitchRendering).toBe(false);
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
  });

  test("a different pitch stops it: one stem of the old pitch was started, never four", async () => {
    const { r, originals, choir } = await midRender();
    choir(7);
    await vt.advanceAsync(8000, 10);
    expect(CountingBuffer.reads).toBe(1 + STEMS.length);
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    expect(live.some((s) => originals.has(s.buffer))).toBe(false);
  });

  test("CHOIR switched off mid-render stops it and leaves the phone on the unshifted stems", async () => {
    const { r, originals } = await midRender();
    const before = r.counters.pitchYields;
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: makeAssignment() });
    await vt.advanceAsync(5000, 10);
    expect(r.counters.pitchYields - before).toBeLessThanOrEqual(2);
    expect(CountingBuffer.reads).toBe(1);
    expect(r.engine.debug.pitchRendering).toBe(false);
    expect(r.ctx.liveSources().every((s) => originals.has(s.buffer))).toBe(true);
  });

  test("dispose stops it and leaves no timer behind", async () => {
    const { r } = await midRender();
    const before = r.counters.pitchYields;
    r.engine.dispose();
    await vt.advanceAsync(3000, 10);
    expect(r.counters.pitchYields - before).toBeLessThanOrEqual(1);
    expect(vt.pending).toBe(0);
  });

  test("a context rebuild does NOT restart it: the render is context-independent and lands on the new scheduler", async () => {
    const { r, originals } = await midRender();
    vt.advance(2000 - (vt.nowMs % 2000));
    r.ctx.freeze(); // the iOS zombie
    await vt.advanceAsync(4000, 10); // the render carries on (it is not audio work) while the watchdog decides
    expect(r.engine.state).toBe("locked");
    await r.engine.unlock();
    expect(r.contexts).toHaveLength(2);
    await vt.advanceAsync(6000, 10);
    expect(CountingBuffer.reads).toBe(STEMS.length); // rendered once, not once per context
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    expect(live.some((s) => originals.has(s.buffer))).toBe(false);
  });
});
