/**
 * ENGINE-SYNC-18 · the drift check during an interruption.
 *
 * Found by the engine soak test (97 "resyncs" in three hours where nine interruptions should have cost
 * nine). While a context is suspended its clock stands still, the timeline does not, and the scheduler's
 * 1 Hz drift check read that as an error growing by a second per second — so it hard-resynced every
 * second, each time building a new branch to start at `currentTime + 50 ms`: the same frozen instant.
 * When the context resumed, every one of those branches started together.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig, LOCAL0, STEMS } from "./engine-rig";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

async function playingRig() {
  const r = engineRig(vt, { durationSec: 300 });
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(LOCAL0 + 600) });
  await flushMicrotasks();
  vt.advance(10_000);
  expect(r.ctx.liveSources()).toHaveLength(STEMS.length);
  return r;
}

/** The most copies of any one stem sounding at any instant in the `ms` after `from` (ctx seconds). */
function worstPileUp(r: Awaited<ReturnType<typeof playingRig>>, from: number, ms: number): number {
  let worst = 0;
  for (let t = from; t < from + ms / 1000; t += 0.001) {
    worst = Math.max(worst, r.ctx.sources.filter((s) => s.liveAt(t)).length / STEMS.length);
  }
  return worst;
}

describe("ENGINE-SYNC-18 · no resync storm while the audio clock stands still", () => {
  test("a 60 s interruption builds nothing, and the resume is one crossfade — not sixty branches at once", async () => {
    const r = await playingRig();
    const nodesBefore = r.ctx.sources.length + r.ctx.gains.length;
    const resyncsBefore = r.engine.debug.resyncCount as number;

    r.ctx.state = "interrupted"; // a call comes in; the page stays in the foreground, timers keep running
    r.ctx.onstatechange?.();
    r.ctx.freeze();
    vt.advance(60_000);
    expect(r.ctx.sources.length + r.ctx.gains.length).toBe(nodesBefore);
    expect(r.engine.debug.resyncCount).toBe(resyncsBefore);

    const resumedAt = r.ctx.currentTime;
    r.ctx.thaw();
    await r.engine.unlock(); // Tap to resume
    await flushMicrotasks();
    vt.advance(3000);

    // one correction, of the size of what was lost
    expect(r.engine.debug.resyncCount).toBe(resyncsBefore + 1);
    expect(Math.abs(r.engine.lastCorrectionMs)).toBeCloseTo(60_000, -2);
    // never more than the two copies a crossfade needs
    expect(worstPileUp(r, resumedAt, 500)).toBeLessThanOrEqual(2);
    // and back on the timeline
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    const expected = (r.localMs() - (LOCAL0 + 600)) / 1000;
    for (const s of live) expect(s.contentPositionAt(r.ctx.currentTime)).toBeCloseTo(expected, 2);
  });

  test("the same for a zombie ('running', clock frozen) in the seconds before the watchdog flags it", async () => {
    const r = await playingRig();
    const nodesBefore = r.ctx.sources.length + r.ctx.gains.length;
    r.ctx.freeze(); // state stays 'running'
    vt.advance(5900);
    expect(r.ctx.sources.length + r.ctx.gains.length).toBe(nodesBefore);
    expect(r.engine.debug.resyncCount).toBe(0);
  });

  test("a healthy clock is still corrected: a real 40 ms jump is resynced on the next tick", async () => {
    const r = await playingRig();
    const t = r.localMs();
    r.clock.addProbe(t, t + 40, t + 40, t); // the server clock is 40 ms ahead of what we believed
    vt.advance(1100);
    expect(r.engine.debug.resyncCount).toBe(1);
  });
});
