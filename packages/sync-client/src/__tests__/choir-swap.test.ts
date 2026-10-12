/**
 * ENGINE-SYNC-01 · CHOIR's buffer swap has to reach the speaker.
 *
 * The pitched render takes seconds, so the phone starts on the as-decoded stems and swaps when the render
 * lands. `Scheduler.setBuffers()` only replaces what the *next* branch is built from, and the forced
 * `apply()` that followed saw an unchanged transport and did nothing — so a phone told to sing an octave up
 * mid-song kept playing the original until something unrelated (a seek, a pause) rebuilt the branch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RESYNC_CROSSFADE_MS, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler } from "../scheduler";
import { engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

const playing = (at: number): Transport => ({ state: "playing", serverTimeAtTrackZero: at });
const applyOpts = { trackId: "t", useOutputLatency: false };

function schedulerRig() {
  let localMs = LOCAL0;
  const clock = new ClockModel();
  clock.addProbe(localMs, localMs, localMs, localMs);
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => 5 + (localMs - LOCAL0) / 1000 });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => localMs });
  const originals = new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const));
  scheduler.setBuffers(originals, "t");
  return { ctx, scheduler, originals, advance: (ms: number) => void (localMs += ms), now: () => localMs };
}

describe("ENGINE-SYNC-01 · a buffer swap under a running branch", () => {
  test("crossfades onto the new buffers at the same track position", () => {
    const r = schedulerRig();
    const a = makeAssignment();
    r.scheduler.apply(playing(r.now() + 600), a, applyOpts);
    r.advance(10_600); // 10 s into the song
    const pitched = new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const));
    r.scheduler.setBuffers(pitched, "t");
    const res = r.scheduler.apply(playing(LOCAL0 + 600), a, { ...applyOpts, force: true });
    expect(res.action).toBe("restarted");

    const fresh = r.ctx.sources.slice(STEMS.length);
    expect(fresh).toHaveLength(STEMS.length);
    for (const s of fresh) {
      expect([...pitched.values()]).toContain(s.buffer as FakeBuffer);
      // same timeline: position p plays at startCtxForZero + p, exactly as on the branch it replaces
      expect(s.starts[0]!.when - s.starts[0]!.offset).toBeCloseTo(5.6, 9);
      expect(s.starts[0]!.when).toBeGreaterThan(r.ctx.currentTime);
    }
    // the old branch is gone one crossfade later: never two copies of a stem for longer than that
    const fadeEnd = fresh[0]!.starts[0]!.when + RESYNC_CROSSFADE_MS / 1000;
    for (const s of r.ctx.sources.slice(0, STEMS.length)) expect(s.endsAt).toBeCloseTo(fadeEnd, 9);
    // a swap is not a sync correction and must not be reported as one
    expect(r.scheduler.resyncCount).toBe(0);
    expect(r.scheduler.lastCorrectionMs).toBe(0);
  });

  test("is applied once: later snapshots do not restart the audio again", () => {
    const r = schedulerRig();
    const a = makeAssignment();
    r.scheduler.apply(playing(r.now() + 600), a, applyOpts);
    r.advance(5000);
    r.scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "t");
    r.scheduler.apply(playing(LOCAL0 + 600), a, applyOpts);
    const after = r.ctx.sources.length;
    for (let i = 0; i < 10; i++) {
      r.advance(500);
      expect(r.scheduler.apply(playing(LOCAL0 + 600), a, applyOpts).action).toBe("unchanged");
    }
    expect(r.ctx.sources.length).toBe(after);
  });

  test("before the start instant it rebuilds the branch on the exact start time (nothing audible yet)", () => {
    const r = schedulerRig();
    const a = makeAssignment();
    r.scheduler.apply(playing(r.now() + 5000), a, applyOpts); // a track-advance lead
    r.advance(1000);
    const pitched = new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const));
    r.scheduler.setBuffers(pitched, "t");
    r.scheduler.apply(playing(LOCAL0 + 5000), a, { ...applyOpts, force: true });
    const fresh = r.ctx.sources.slice(STEMS.length);
    expect(fresh).toHaveLength(STEMS.length);
    for (const s of fresh) {
      expect(s.starts[0]).toEqual({ when: 10, offset: 0 });
      expect([...pitched.values()]).toContain(s.buffer as FakeBuffer);
    }
    // the superseded sources never sound
    for (const s of r.ctx.sources.slice(0, STEMS.length)) expect(s.endsAt).toBeLessThan(10);
  });
});

describe("ENGINE-SYNC-01 · CHOIR through the engine", () => {
  let vt: VirtualTime;
  beforeEach(() => {
    vt = new VirtualTime().install();
  });
  afterEach(() => vt.uninstall());

  test("a pitch assignment that arrives mid-song is audible once rendered, and clearing it restores the originals", async () => {
    const originals = new Set<unknown>();
    const r = engineRig(vt, {
      durationSec: 20,
      loadStem: async () => {
        const b = new FakeBuffer(20, 8000); // a low rate keeps the real WSOLA render quick
        originals.add(b);
        return b;
      },
    });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    expect(r.engine.debug.playing).toBe(true);
    vt.advance(3000);
    expect(r.ctx.liveSources().every((s) => originals.has(s.buffer))).toBe(true);

    const choir = makeAssignment({ pitchSemitones: 12 });
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: choir });
    await vt.advanceAsync(2000, 10); // the render yields through setTimeout(0)

    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    expect(live.some((s) => originals.has(s.buffer))).toBe(false);
    // still on the timeline: position (now − zero) is what is sounding
    const expected = (r.localMs() - (LOCAL0 + 600)) / 1000;
    for (const s of live) expect(s.positionAt(r.ctx.currentTime)).toBeCloseTo(expected, 6);

    // CHOIR off again: back to the decoded stems, same position
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: makeAssignment() });
    await vt.advanceAsync(500, 10);
    const back = r.ctx.liveSources();
    expect(back).toHaveLength(STEMS.length);
    expect(back.every((s) => originals.has(s.buffer))).toBe(true);
  });
});
