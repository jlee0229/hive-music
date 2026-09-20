/**
 * B3-lite: the scheduling arithmetic, against a fake AudioContext and a mocked clock.
 *
 * The two worked examples in docs/03-sync-engine.md ("start from zero" and "late join / resume") are
 * asserted literally — numbers and all — because they are the contract between this file and the plan.
 * If either changes, the doc and the code have to move together.
 */
import { describe, expect, test } from "bun:test";
import { LEAD_MS, type Assignment, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { decideStart, FUTURE_START_MARGIN_SEC, LATE_START_MARGIN_SEC, gainFromDb, Scheduler } from "../scheduler";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const DURATION = 60;

/** A clock pinned to an exact offset, so the mapping under test is the only moving part. */
function pinnedClock(offsetMs: number, localAt: number, ctxAt: number) {
  const clock = new ClockModel();
  // one probe with symmetric delays produces exactly `offsetMs`
  const t0 = localAt;
  const t1 = t0 + offsetMs;
  clock.addProbe(t0, t1, t1, t0);
  const mapper = new CtxMapper(clock);
  mapper.addSample(localAt, ctxAt);
  return { clock, mapper };
}

interface RigOptions {
  offsetMs: number;
  localNow: number;
  ctxNow: number;
  outputLatency?: number;
}

function rig(o: RigOptions) {
  const { clock, mapper } = pinnedClock(o.offsetMs, o.localNow, o.ctxNow);
  const ctx = new FakeAudioContext({ startTime: o.ctxNow, outputLatency: o.outputLatency });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => o.localNow });
  const buffers = new Map(STEMS.map((s) => [s, new FakeBuffer(DURATION)] as const));
  scheduler.setBuffers(buffers, "synthetic-60s");
  return { ctx, clock, mapper, scheduler };
}

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  label: "unison",
  role: "unison",
  color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0,
  compensationMs: 0,
  pattern: null,
  applyAtServerTime: null,
  ...over,
});

const playing = (serverTimeAtTrackZero: number): Transport => ({ state: "playing", serverTimeAtTrackZero });
const applyOpts = { trackId: "synthetic-60s", useOutputLatency: false };

describe("decideStart", () => {
  test("a start far enough in the future is scheduled exactly, at offset 0", () => {
    const d = decideStart({ ctxNow: 12, startCtxForZero: 12.39, durationSec: 60 })!;
    expect(d.mode).toBe("scheduled");
    expect(d.whenCtx).toBeCloseTo(12.39, 9);
    expect(d.offsetSec).toBe(0);
  });

  test("a start that is already past becomes an immediate start at the matching offset", () => {
    const d = decideStart({ ctxNow: 42, startCtxForZero: 12.39, durationSec: 60 })!;
    expect(d.mode).toBe("immediate");
    expect(d.whenCtx).toBeCloseTo(42 + LATE_START_MARGIN_SEC, 9);
    expect(d.offsetSec).toBeCloseTo(42 + LATE_START_MARGIN_SEC - 12.39, 9);
  });

  test("a start inside FUTURE_START_MARGIN_SEC is still scheduled exactly (P0-5)", () => {
    // This test used to assert the opposite, and the opposite was a bug: a lead just inside the margin
    // took the immediate path and played position 0 up to 30 ms early, invisibly to the drift check.
    const at = decideStart({ ctxNow: 10, startCtxForZero: 10 + FUTURE_START_MARGIN_SEC, durationSec: 60 })!;
    expect(at.mode).toBe("scheduled");
    const inside = decideStart({ ctxNow: 10, startCtxForZero: 10 + FUTURE_START_MARGIN_SEC - 0.001, durationSec: 60 })!;
    expect(inside.mode).toBe("scheduled");
    expect(inside.whenCtx).toBeCloseTo(10 + FUTURE_START_MARGIN_SEC - 0.001, 9);
    expect(inside.offsetSec).toBe(0);
    // only a start that is genuinely in the past becomes an immediate one
    expect(decideStart({ ctxNow: 10, startCtxForZero: 9.9, durationSec: 60 })!.mode).toBe("immediate");
  });

  test("past the end of the track there is nothing to start", () => {
    expect(decideStart({ ctxNow: 100, startCtxForZero: 10, durationSec: 60 })).toBeNull();
    // and one sample before the end there still is
    expect(decideStart({ ctxNow: 69, startCtxForZero: 10, durationSec: 60 })).not.toBeNull();
  });
});

describe("Scheduler: the worked examples from docs/03", () => {
  test("start from zero: estServerNow 1 000 000, ctx 12.000, comp 60 → source.start(12.390, 0)", () => {
    // PLAY was issued at 999 850 with from = 0, so zero = 999 850 + LEAD_MS.
    const localNow = 1_000_000 - 137; // any local time; the offset makes estServerNow exactly 1 000 000
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const zero = 999_850 + LEAD_MS;
    expect(zero).toBe(1_000_450);

    const result = scheduler.apply(playing(zero), assignment({ compensationMs: 60 }), applyOpts);
    expect(result.action).toBe("started");
    expect(result.decision!.mode).toBe("scheduled");
    expect(result.decision!.whenCtx).toBeCloseTo(12.39, 6);
    expect(result.decision!.offsetSec).toBe(0);

    // every stem starts at the identical when/offset: skew between stems on one phone must be zero
    const starts = ctx.allStarts();
    expect(starts).toHaveLength(STEMS.length);
    for (const s of starts) {
      expect(s.when).toBeCloseTo(12.39, 9);
      expect(s.offset).toBe(0);
    }
  });

  test("late join: estServerNow 1 030 000, ctx 42.000, comp 60 → source.start(42.020, 29.630)", () => {
    const localNow = 1_030_000 - 137;
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 42 });
    const zero = 1_000_450;

    const result = scheduler.apply(playing(zero), assignment({ compensationMs: 60 }), applyOpts);
    expect(result.action).toBe("started");
    expect(result.decision!.mode).toBe("immediate");
    // The doc works the example with a 50 ms margin and gets 29.660; the engine uses
    // LATE_START_MARGIN_SEC = 20 ms, so the same arithmetic gives 29.630 at ctx 42.020.
    // The invariant the doc is really asserting is the one checked below: position p leaves the
    // speaker at the server time the timeline says it should.
    expect(result.decision!.whenCtx).toBeCloseTo(42.02, 6);
    expect(result.decision!.offsetSec).toBeCloseTo(29.63, 6);

    // check exactly as the doc does: position 29.630 leaves the speaker at ctx 42.020 + 0.060
    // → server time 1 030 110 = zero + 29 660 ms... i.e. the emitted position is right.
    const emitCtx = result.decision!.whenCtx + 60 / 1000;
    const emitServerTime = 1_030_000 + (emitCtx - 42) * 1000;
    expect(emitServerTime).toBeCloseTo(zero + result.decision!.offsetSec * 1000, 3);
    expect(ctx.allStarts()).toHaveLength(STEMS.length);
  });

  test("compensation advances the schedule by exactly its own value", () => {
    const localNow = 1_000_000 - 137;
    const base = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const zero = 1_000_450;
    const none = base.scheduler.apply(playing(zero), assignment({ compensationMs: 0 }), applyOpts);

    const nudged = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const late = nudged.scheduler.apply(playing(zero), assignment({ compensationMs: 40 }), applyOpts);
    // +40 ms of compensation = "this device is late" = start 40 ms earlier
    expect(none.decision!.whenCtx - late.decision!.whenCtx).toBeCloseTo(0.04, 9);
  });

  test("WAVE's delayMs pushes the start later by exactly delayMs", () => {
    const localNow = 1_000_000 - 137;
    const plain = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const zero = 1_000_450;
    const a = plain.scheduler.apply(playing(zero), assignment(), applyOpts);

    const waved = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const b = waved.scheduler.apply(playing(zero), assignment({ delayMs: 240, pattern: null }), applyOpts);
    expect(b.decision!.whenCtx - a.decision!.whenCtx).toBeCloseTo(0.24, 9);
  });

  test("outputLatency is only subtracted when the server has no latency knowledge", () => {
    const localNow = 1_000_000 - 137;
    const zero = 1_000_450;
    const withTable = rig({ offsetMs: 137, localNow, ctxNow: 12, outputLatency: 0.031 });
    const a = withTable.scheduler.apply(playing(zero), assignment({ compensationMs: 60 }), { ...applyOpts, useOutputLatency: false });

    const unknown = rig({ offsetMs: 137, localNow, ctxNow: 12, outputLatency: 0.031 });
    const b = unknown.scheduler.apply(playing(zero), assignment({ compensationMs: 0 }), { ...applyOpts, useOutputLatency: true });
    expect(a.decision!.whenCtx).toBeCloseTo(12.39, 6); // 12.45 − 0.060 table
    expect(b.decision!.whenCtx).toBeCloseTo(12.45 - 0.031, 6); // 12.45 − ctx.outputLatency
  });
});

describe("Scheduler: transport transitions", () => {
  const localNow = 1_000_000 - 137;
  const zero = 1_000_450;

  test("paused and stopped both stop every source; a repeated snapshot is a no-op", () => {
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    scheduler.apply(playing(zero), assignment(), applyOpts);
    expect(scheduler.playing).toBe(true);

    // the same snapshot again must not restart anything (ROOM_STATE arrives at 2 Hz)
    const again = scheduler.apply(playing(zero), assignment(), applyOpts);
    expect(again.action).toBe("unchanged");
    expect(ctx.allStarts()).toHaveLength(STEMS.length);

    const paused = scheduler.apply({ state: "paused", trackTimeAtPause: 12.5 }, assignment(), applyOpts);
    expect(paused.action).toBe("stopped");
    expect(scheduler.playing).toBe(false);
    expect(ctx.sources.every((s) => s.stops.length === 1)).toBe(true);

    const stopped = scheduler.apply({ state: "stopped" }, assignment(), applyOpts);
    expect(stopped.action).toBe("idle");
  });

  test("a seek is a new serverTimeAtTrackZero, so it restarts at the new offset", () => {
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    scheduler.apply(playing(zero), assignment(), applyOpts);
    const firstCount = ctx.allStarts().length;

    // seek to 30 s: the server moves track zero 30 s into the past
    const seeked = scheduler.apply(playing(zero - 30_000), assignment(), applyOpts);
    expect(seeked.action).toBe("restarted");
    expect(seeked.decision!.mode).toBe("immediate");
    // at estServerNow the un-seeked track position is −0.45 s (zero is LEAD_MS − 150 ms ahead);
    // seeking 30 s in moves that to 29.55, and the immediate start adds LATE_START_MARGIN_SEC.
    expect(seeked.decision!.offsetSec).toBeCloseTo(29.55 + LATE_START_MARGIN_SEC, 6);
    expect(ctx.allStarts().length).toBe(firstCount + STEMS.length);
  });

  test("a mode switch while playing ramps gains and never restarts a source", () => {
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const unison = assignment();
    scheduler.apply(playing(zero), unison, applyOpts);
    const startsAfterPlay = ctx.allStarts().length;

    // ORCHESTRA: this phone keeps drums, everything else goes silent
    const orchestra = assignment({
      label: "drums",
      role: "drums",
      gainsDb: { drums: 0, bass: -60, vocals: -60, other: -60 },
    });
    const result = scheduler.apply(playing(zero), orchestra, applyOpts);
    expect(result.action).toBe("unchanged");
    expect(ctx.allStarts().length).toBe(startsAfterPlay); // no reload, no new sources

    // the ramps went to the right targets, through setTargetAtTime
    const ramped = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget"));
    expect(ramped.some((e) => e.value === 0)).toBe(true); // −60 dB is silence
    expect(ramped.some((e) => e.value === 1)).toBe(true); // 0 dB is unity
  });

  test("applyAtServerTime ramps at that instant, not on arrival", () => {
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    scheduler.apply(playing(zero), assignment(), applyOpts);
    // a scene boundary 1.5 s in the future on the shared clock
    const boundary = 1_000_000 + 1500;
    scheduler.apply(playing(zero), assignment({ gainsDb: { drums: 0, bass: -60, vocals: -60, other: -60 }, applyAtServerTime: boundary }), applyOpts);
    const targets = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget"));
    // ctx 12.000 is server 1 000 000, so the boundary maps to ctx 13.5
    expect(targets.some((e) => Math.abs(e.time - 13.5) < 1e-6)).toBe(true);
  });

  test("a track that is not loaded, or a different track, schedules nothing", () => {
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    const other = scheduler.apply(playing(zero), assignment(), { ...applyOpts, trackId: "some-other-track" });
    expect(other.action).toBe("idle");
    expect(ctx.allStarts()).toHaveLength(0);
  });

  test("joining after the track has ended schedules nothing and says so", () => {
    const localLate = 1_000_000 + 70_000 - 137;
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow: localLate, ctxNow: 82 });
    const result = scheduler.apply(playing(zero), assignment(), applyOpts);
    expect(result.action).toBe("finished");
    expect(ctx.allStarts()).toHaveLength(0);
  });
});

describe("gain conversion", () => {
  test("dB to linear, with −60 dB as exact silence", () => {
    expect(gainFromDb(0)).toBeCloseTo(1, 12);
    expect(gainFromDb(-6)).toBeCloseTo(0.5011872336, 9);
    expect(gainFromDb(-60)).toBe(0);
    expect(gainFromDb(-61)).toBe(0);
    expect(gainFromDb(6)).toBeCloseTo(1.9952623150, 9);
  });
});

describe("pattern automation", () => {
  test("a WAVE pattern writes a value curve ahead of the playhead", () => {
    const localNow = 1_000_000 - 137;
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    scheduler.apply(
      playing(1_000_450),
      assignment({ pattern: { kind: "wave", periodMs: 2000, phaseMs: 0 } }),
      applyOpts,
    );
    const curves = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve"));
    expect(curves.length).toBeGreaterThan(0);
    const curve = curves[0]!;
    expect(curve.duration).toBeCloseTo(0.2, 6); // PATTERN_LOOKAHEAD_MS
    expect(curve.curve!.length).toBeGreaterThan(2);
    // a raised-cosine swell starting at the phase origin begins near 0
    expect(curve.curve![0]!).toBeLessThan(0.05);
    for (const v of curve.curve!) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    scheduler.dispose();
  });

  test("clearing the pattern returns the gain to unity", () => {
    const localNow = 1_000_000 - 137;
    const { ctx, scheduler } = rig({ offsetMs: 137, localNow, ctxNow: 12 });
    scheduler.apply(playing(1_000_450), assignment({ pattern: { kind: "strobe", periodMs: 500, phaseMs: 0, duty: 0.5, rampMs: 10 } }), applyOpts);
    scheduler.apply(playing(1_000_450), assignment({ pattern: null }), applyOpts);
    const targets = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget" && e.value === 1));
    expect(targets.length).toBeGreaterThan(0);
    scheduler.dispose();
  });
});
