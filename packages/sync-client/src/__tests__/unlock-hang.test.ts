/**
 * ENGINE-SYNC-12 · unlock() must come back.
 *
 * `AudioContext.resume()` can stay pending — neither resolved nor rejected — while iOS holds the audio
 * session (a call, Siri, another app's audio). unlock() awaited it without a bound, and the player page
 * ignores taps while an unlock is in flight (`if (resuming) return`), so one such resume() left the
 * phone on "Resuming…" with every further tap discarded. Not reproducible off-device; the fake context
 * here stands in for the hang.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig, LOCAL0, STEMS } from "./engine-rig";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const settle = async (p: Promise<void>): Promise<string> => {
  let outcome = "pending";
  void p.then(
    () => (outcome = "resolved"),
    (e: Error) => (outcome = `rejected: ${e.message}`),
  );
  await flushMicrotasks();
  return outcome;
};

describe("ENGINE-SYNC-12 · a resume() that never settles", () => {
  test("unlock() rejects after a bound, and the next tap rebuilds the context and plays", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    expect(r.engine.debug.playing).toBe(true);
    vt.advance(5000);

    // an interruption: the context is suspended and resume() hangs
    const first = r.ctx;
    first.state = "suspended";
    first.onstatechange?.();
    first.freeze();
    first.hangResume = true;
    expect(r.engine.state).toBe("locked");

    const tap = r.engine.unlock(); // "Tap to resume"
    expect(await settle(tap)).toBe("pending");
    await vt.advanceAsync(4100);
    expect(await settle(tap)).toMatch(/^rejected: AudioContext\.resume\(\) did not settle/);
    expect(r.engine.state).toBe("locked"); // still asking for a tap, not pretending to play

    // the second tap does not ask the dead context again: it builds a new one
    await r.engine.unlock();
    await flushMicrotasks();
    expect(r.contexts).toHaveLength(2);
    expect(first.closeCalls).toBe(1);
    expect(r.engine.state).toBe("ready");
    const live = r.ctx.liveSources(r.ctx.currentTime + 0.05);
    expect(live).toHaveLength(STEMS.length);
    const expected = (r.localMs() - (LOCAL0 + 600)) / 1000;
    for (const s of live) expect(s.positionAt(r.ctx.currentTime)).toBeCloseTo(expected, 6);
  });

  test("a resume() that settles in time leaves no timer behind and is not treated as a failure", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    const timersAfterUnlock = vt.pending;
    r.ctx.state = "suspended";
    r.ctx.onstatechange?.();
    await r.engine.unlock();
    expect(vt.pending).toBe(timersAfterUnlock);
    await vt.advanceAsync(10_000);
    await r.engine.unlock();
    expect(r.contexts).toHaveLength(1); // never flagged as a zombie
  });
});
