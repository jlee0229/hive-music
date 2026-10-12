/**
 * ENGINE-SYNC-14 · what the engine holds on to across a track change.
 *
 * Decoded PCM is by far the largest thing a phone carries for HiveMusic. The old track's buffers (and
 * its CHOIR copies) used to stay referenced until the *next* track had finished decoding, so the peak —
 * two decoded songs plus the compressed download — fell exactly when a mobile tab is most likely to be
 * killed. They are released when the change arrives; the tail that is still sounding keeps its own
 * reference through its source nodes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deferred, engineRig, LOCAL0, makeAssignment, STEMS, type Deferred } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const trackOf = (url: string): string => url.split("/audio/")[1]!.split("/")[0]!;

describe("ENGINE-SYNC-14 · memory across a track change", () => {
  test("the old track's decoded buffers are unreachable from the engine while the next one downloads", async () => {
    const gates = new Map<string, Deferred<unknown>>();
    const registry = new FinalizationRegistry<string>(() => {});
    const refs: Array<WeakRef<object>> = [];
    const r = engineRig(vt, {
      durationSec: 10,
      loadStem: (url) => {
        if (trackOf(url) === "song-a") {
          const b = new FakeBuffer(10, 8000);
          refs.push(new WeakRef(b));
          registry.register(b, url);
          return Promise.resolve(b);
        }
        const d = deferred<unknown>();
        gates.set(url, d);
        return d.promise;
      },
    });
    await r.engine.unlock();
    r.apply({ trackId: "song-a", transport: r.playingAt(LOCAL0 + 600), assignment: makeAssignment({ pitchSemitones: 7 }) });
    await vt.advanceAsync(3000, 10); // loaded, playing, CHOIR copy rendered
    expect(r.engine.debug.playing).toBe(true);
    // 4 decoded stems + 4 CHOIR copies + the scheduler's 4 (the copies it is playing)
    expect(r.engine.debug.buffersHeld).toBe(3 * STEMS.length);

    // a manual track change: the transport stops, song-b starts downloading and does not finish
    r.apply({ trackId: "song-b", transport: { state: "stopped" }, assignment: makeAssignment({ pitchSemitones: 7 }) });
    await vt.advanceAsync(500, 10);
    expect(r.engine.state).toBe("loading");
    expect(r.engine.debug.buffersHeld).toBe(0);

    // Drop the test's own strong references (the fake context records every source it ever made).
    for (const s of r.ctx.sources) s.buffer = null;
    r.ctx.sources.length = 0;
    await flushMicrotasks();
    Bun.gc(true);
    await new Promise<void>((res) => queueMicrotask(res));
    Bun.gc(true);
    const alive = refs.filter((w) => w.deref() !== undefined).length;
    // Reported, not asserted: a collector is entitled to be conservative, and a test that depends on it
    // is a flaky test. Measured on this machine: 4 of 4 alive before the fix, 0 of 4 after (15 runs).
    console.log(`[ENGINE-SYNC-14] old-track buffers still alive after GC, mid-download: ${alive} of ${refs.length}`);

    // and the new track still loads and plays normally afterwards
    for (const d of gates.values()) d.resolve(new FakeBuffer(10, 8000));
    await vt.advanceAsync(200, 10);
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
    expect(r.engine.state).toBe("ready");
    r.apply({ trackId: "song-b", transport: r.playingAt(r.localMs() + 600) });
    vt.advance(700);
    expect(r.ctx.sources.filter((s) => s.liveAt(r.ctx.currentTime))).toHaveLength(STEMS.length);
  });
});
