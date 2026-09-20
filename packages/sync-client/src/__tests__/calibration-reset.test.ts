/**
 * CALIBRATION_RESET, engine side.
 *
 * The message itself is server-side bookkeeping — the engine never handles it. What the *engine* owes a
 * reset is that the audio actually moves: clearing `calibratedOffsetMs` changes this phone's
 * `compensationMs`, and a compensation change is a playhead change. If the engine ignored it, the host
 * would press Reset, watch the number disappear from the Hive Map, and hear nothing change — the worst
 * kind of control, one that lies.
 *
 * That behaviour already falls out of the B4 rule (a timing shift over RESYNC_THRESHOLD_MS reschedules,
 * under it is left to the drift check to slew), so these tests pin the rule *at the reset boundary*
 * rather than adding a code path for it. A realistic reset is 40–100 ms — an iOS phone whose
 * calibration matched a sidelobe — which is 4–10× the threshold, so it is always the reschedule branch.
 */
import { describe, expect, test } from "bun:test";
import { RESYNC_THRESHOLD_MS, type Assignment, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler } from "../scheduler";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;

function rig() {
  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL); // offset 0
  const mapper = new CtxMapper(clock);
  mapper.addSample(LOCAL, CTX0);
  const ctx = new FakeAudioContext({ startTime: CTX0 });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "synthetic-60s");
  return { ctx, scheduler };
}

/** The planner's output for one phone, parameterised by the compensation the server derived. */
const withCompensation = (compensationMs: number): Assignment => ({
  label: "unison",
  role: "unison",
  color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0,
  compensationMs,
  pattern: null,
  applyAtServerTime: null,
});

// Already playing, so a reset lands mid-song — which is when a host actually reaches for it.
const playing: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL - 5_000 };
const applyOpts = { trackId: "synthetic-60s", useOutputLatency: false };

describe("clearing calibratedOffsetMs moves this phone's playhead", () => {
  test("a 40 ms reset (a sidelobe match, cleared back to the table row) reschedules the audio", () => {
    const { ctx, scheduler } = rig();
    // measured badly: 100 ms of compensation, i.e. 40 ms more than its ios-safari table row deserves
    scheduler.apply(playing, withCompensation(100), applyOpts);
    const before = scheduler.startCtxForZero!;
    const startedBefore = ctx.sources.length;

    // the host resets; the server replans and this phone's compensation falls back to the table row
    const result = scheduler.apply(playing, withCompensation(60), applyOpts);

    expect(result.action).toBe("restarted");
    expect(ctx.sources.length).toBeGreaterThan(startedBefore); // new sources, i.e. the audio really moved
    /*
     * compensationMs is subtracted from the ctx time of track zero (docs/02 §1: positive = this device
     * is late, so play it earlier). Compensating 40 ms LESS means track zero is 40 ms LATER.
     */
    expect(scheduler.startCtxForZero! - before).toBeCloseTo(0.04, 6);
  });

  test("the direction is right for a reset that removes compensation in the other direction too", () => {
    const { scheduler } = rig();
    // an under-measured phone: the table row says 60, calibration wrote 20
    scheduler.apply(playing, withCompensation(20), applyOpts);
    const before = scheduler.startCtxForZero!;
    scheduler.apply(playing, withCompensation(60), applyOpts);
    // compensating 40 ms MORE means track zero is 40 ms EARLIER
    expect(scheduler.startCtxForZero! - before).toBeCloseTo(-0.04, 6);
  });

  test("a reset smaller than the resync threshold is slewed, not restarted", () => {
    const { ctx, scheduler } = rig();
    scheduler.apply(playing, withCompensation(60), applyOpts);
    const startedBefore = ctx.sources.length;
    // a well-calibrated phone reset to its table row: a 3 ms change is inside RESYNC_THRESHOLD_MS
    const result = scheduler.apply(playing, withCompensation(63), applyOpts);
    expect(Math.abs(63 - 60)).toBeLessThan(RESYNC_THRESHOLD_MS);
    expect(result.action).toBe("unchanged");
    expect(ctx.sources.length).toBe(startedBefore); // a 3 ms restart would be an audible glitch for nothing
  });

  test("a reset while stopped changes nothing audible and does not arm a source", () => {
    const { ctx, scheduler } = rig();
    const stopped: Transport = { state: "stopped" };
    scheduler.apply(stopped, withCompensation(100), applyOpts);
    const startedBefore = ctx.sources.length;
    scheduler.apply(stopped, withCompensation(60), applyOpts);
    expect(ctx.sources.length).toBe(startedBefore);
    // the next PLAY picks the cleared value up through the normal path
    scheduler.apply(playing, withCompensation(60), applyOpts);
    expect(ctx.sources.length).toBeGreaterThan(startedBefore);
  });
});
