/**
 * ENGINE-SYNC-07 · a branch that is scheduled but not yet sounding can still be corrected.
 *
 * A playlist advance gives every phone a start ~5 s ahead. For those five seconds the drift check had no
 * tool that worked: a crossfade was refused ("the correction would land outside the track"), and a rate
 * trim was written to a source that was not playing and then booked as content it had consumed. Whatever
 * moved during the wait — the clock stepping as the burst after a heavy decode lands, the output route
 * changing — was carried into the song and only fixed by the first drift tick after the start.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PLAYBACK_RATE_DEADBAND_MS, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler } from "../scheduler";
import { makeAssignment, STEMS } from "./engine-rig";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";
import { VirtualTime } from "./sim";

const LOCAL0 = 1_700_000_000_000;
const CTX0 = 5;
const applyOpts = { trackId: "t", useOutputLatency: false };

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

/** A scheduler whose drift timer really runs, with a server clock the test can move. */
function rig() {
  let trueOffset = 0;
  const localMs = (): number => LOCAL0 + vt.nowMs;
  const clock = new ClockModel();
  const sync = (): void => {
    const t = localMs();
    clock.addProbe(t, t + trueOffset, t + trueOffset, t);
  };
  sync();
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => CTX0 + vt.nowMs / 1000 });
  ctx.state = "running"; // the drift check stands down on a context that is not (ENGINE-SYNC-18)
  const scheduler = new Scheduler({ ctx, clock, mapper, now: localMs });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "t");
  const zeroServer = localMs() + 5000; // the 5 s lead of a track advance
  const transport: Transport = { state: "playing", serverTimeAtTrackZero: zeroServer };
  /** Track position that should be sounding at ctx time `t`, from the true server clock. */
  const idealPositionAt = (ctxTime: number): number => {
    const local = LOCAL0 + (ctxTime - CTX0) * 1000;
    return (local + trueOffset - zeroServer) / 1000;
  };
  return {
    ctx,
    scheduler,
    transport,
    sync,
    idealPositionAt,
    stepServerClock(ms: number): void {
      trueOffset += ms;
      sync();
    },
    /** Sources that will be sounding once the song is under way. */
    sounding: (t: number) => ctx.sources.filter((s) => s.liveAt(t)),
  };
}

describe("ENGINE-SYNC-07 · corrections during the lead", () => {
  test("a clock step during the 5 s lead moves the start itself: the song begins on time", () => {
    const r = rig();
    const a = makeAssignment();
    r.scheduler.apply(r.transport, a, applyOpts);
    vt.advance(1500);
    r.stepServerClock(-40); // the server clock is 40 ms behind what this phone believed: the start is 40 ms later
    vt.advance(1000); // one drift check

    // nothing has sounded yet, so this is not a resync and must not be reported as one
    expect(r.scheduler.resyncCount).toBe(0);

    vt.advance(2640); // 100 ms into the song (the start moved to local +5040)
    const live = r.sounding(r.ctx.currentTime);
    expect(live).toHaveLength(STEMS.length);
    for (const s of live) {
      expect(s.starts[0]!.offset).toBe(0); // started from the top, at the right instant — no crossfade
      expect((s.contentPositionAt(r.ctx.currentTime) - r.idealPositionAt(r.ctx.currentTime)) * 1000).toBeCloseTo(0, 6);
    }
    // and the superseded sources never made a sound
    const superseded = r.ctx.sources.filter((s) => !live.includes(s));
    expect(superseded.length).toBeGreaterThan(0);
    for (const s of superseded) expect(s.endsAt).toBeLessThanOrEqual(s.starts[0]!.when);
  });

  test("a sub-threshold shift during the lead is not 'trimmed' on a silent source and then mis-booked", () => {
    const r = rig();
    const a = makeAssignment();
    r.scheduler.apply(r.transport, a, applyOpts);
    vt.advance(500);
    // +6 ms of compensation (a nudge): under the resync threshold, so `apply` leaves it to the drift check
    const nudged = makeAssignment({ compensationMs: 6 });
    r.scheduler.apply(r.transport, nudged, applyOpts);
    vt.advance(4400); // four drift checks pass before anything sounds

    vt.advance(200); // 100 ms into the song (compensation starts it 6 ms early)
    const now = r.ctx.currentTime;
    const live = r.sounding(now);
    expect(live).toHaveLength(STEMS.length);
    for (const s of live) {
      // what is sounding is what should be: 6 ms ahead of the uncompensated timeline, exactly
      const errMs = (s.contentPositionAt(now) - (r.idealPositionAt(now) + 0.006)) * 1000;
      expect(Math.abs(errMs)).toBeLessThan(PLAYBACK_RATE_DEADBAND_MS);
      // no rate trim was ever written before the start
      expect(s.playbackRate.events.filter((e) => e.time < s.starts[0]!.when)).toHaveLength(0);
    }
    // and the scheduler's own books agree with the truth: its reported error is the real one
    const reported = r.scheduler.driftErrorMs(nudged, false)!;
    expect(Math.abs(reported)).toBeLessThan(PLAYBACK_RATE_DEADBAND_MS);
  });

  test("an unchanged lead is left alone: the same sources that were scheduled are the ones that play", () => {
    const r = rig();
    r.scheduler.apply(r.transport, makeAssignment(), applyOpts);
    const scheduled = [...r.ctx.sources];
    vt.advance(5100);
    expect(r.ctx.sources).toHaveLength(scheduled.length);
    expect(r.sounding(r.ctx.currentTime)).toEqual(scheduled);
  });
});
