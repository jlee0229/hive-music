/**
 * ENGINE-SYNC-08 · a stop that lands inside a crossfade silences the branch that is fading out, too.
 *
 * A hard resync starts the replacement 50 ms ahead and lets the old branch run until then, fading over
 * the following 20 ms. The scheduler used to forget the old branch the moment the crossfade was
 * scheduled — so a pause, a seek or a mode restart arriving in those 70 ms stopped only the replacement,
 * and the old audio kept sounding at full level over whatever came next. Found by the fuzz test
 * (scheduler-fuzz.test.ts) as "a stem doubled for 30 ms".
 */
import { describe, expect, test } from "bun:test";
import { RESYNC_CROSSFADE_MS, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler, RESYNC_START_MARGIN_SEC, STOP_FADE_SEC } from "../scheduler";
import { makeAssignment, STEMS } from "./engine-rig";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const LOCAL0 = 1_700_000_000_000;
const applyOpts = { trackId: "t", useOutputLatency: false };
const playing = (at: number): Transport => ({ state: "playing", serverTimeAtTrackZero: at });

function midCrossfade() {
  let localMs = LOCAL0;
  let offset = 0;
  const clock = new ClockModel();
  const sync = (): void => void clock.addProbe(localMs, localMs + offset, localMs + offset, localMs);
  sync();
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => 5 + (localMs - LOCAL0) / 1000 });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => localMs });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "t");
  const a = makeAssignment();
  scheduler.apply(playing(LOCAL0 + 600), a, applyOpts);
  localMs += 10_000;
  offset = 40; // the clock steps: the playhead is now 40 ms off
  sync();
  expect(scheduler.checkDrift(a, false)!.resynced).toBe(true);
  const old = ctx.sources.slice(0, STEMS.length);
  const fresh = ctx.sources.slice(STEMS.length);
  // the crossfade as scheduled: the old branch runs another 70 ms
  const crossfadeEnd = ctx.currentTime + RESYNC_START_MARGIN_SEC + RESYNC_CROSSFADE_MS / 1000;
  for (const s of old) expect(s.endsAt).toBeCloseTo(crossfadeEnd, 9);
  localMs += 10; // …and 10 ms into it, the host does something
  return { ctx, scheduler, a, old, fresh, serverNow: () => localMs + offset };
}

describe("ENGINE-SYNC-08 · stopping during a crossfade", () => {
  test("pause: nothing is left sounding after the stop fade", () => {
    const r = midCrossfade();
    r.scheduler.apply({ state: "paused", trackTimeAtPause: 10 }, r.a, applyOpts);
    const silentBy = r.ctx.currentTime + STOP_FADE_SEC + 1e-9;
    for (const s of [...r.old, ...r.fresh]) expect(s.endsAt).toBeLessThanOrEqual(silentBy);
    // the fade node of the old branch was brought down with it, not left at full level until its stop
    expect(r.ctx.sources.some((s) => s.liveAt(silentBy + 0.001))).toBe(false);
  });

  test("seek: the old position does not play on over the new one", () => {
    const r = midCrossfade();
    r.scheduler.apply(playing(r.serverNow() + 600 - 30_000), r.a, applyOpts); // jump to 30 s
    const seekTo = r.ctx.sources.slice(2 * STEMS.length);
    expect(seekTo).toHaveLength(STEMS.length);
    const newStart = seekTo[0]!.starts[0]!.when;
    for (const s of [...r.old, ...r.fresh]) expect(s.endsAt).toBeLessThanOrEqual(newStart);
    // one copy of each stem once the new branch is running
    expect(r.ctx.sources.filter((s) => s.liveAt(newStart + 0.001))).toHaveLength(STEMS.length);
  });

  test("an undisturbed crossfade is unchanged: the old branch still gets its full fade", () => {
    const r = midCrossfade();
    const end = r.old[0]!.endsAt;
    r.scheduler.apply(playing(LOCAL0 + 600), r.a, applyOpts); // an ordinary snapshot, nothing new
    for (const s of r.old) expect(s.endsAt).toBe(end);
    for (const s of r.old) expect(s.stops).toHaveLength(1);
  });
});
