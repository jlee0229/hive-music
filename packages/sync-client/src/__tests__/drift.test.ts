/**
 * B4: drift correction. Two independent clocks can drift, and they fail differently:
 *
 *  - the **system clock** drifting against the server is absorbed by the ClockModel's slew (2 ms/s is
 *    40× faster than a 50 ppm drift, which is 0.05 ms/s), so it never reaches the audio;
 *  - the **audio clock** drifting against the system clock cannot be absorbed by the clock model at
 *    all. `ctx.currentTime` advances faster than real time and the samples play faster with it, so the
 *    playhead walks away from the timeline until something moves it back. That something is the hard
 *    resync here.
 *
 * Both are simulated. The numbers are reported rather than asserted loosely, because the honest result
 * differs from the brief's phrasing — see the B4 evidence file.
 */
import { describe, expect, test } from "bun:test";
import { RESYNC_CROSSFADE_MS, RESYNC_THRESHOLD_MS, type Assignment, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper, SLEW_RATE_MS_PER_SEC } from "../clock";
import { Scheduler } from "../scheduler";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL0 = 1_700_000_000_000;
const CTX0 = 5;
const DURATION = 600; // long enough that a 5-minute run stays inside the track

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

const playing = (at: number): Transport => ({ state: "playing", serverTimeAtTrackZero: at });

/**
 * A rig where the test drives both clocks: `localMs` is the system clock (and, with a fixed offset, the
 * server clock), and the AudioContext's `currentTime` runs at `audioPpm` parts per million faster.
 */
function driftRig(audioPpm: number) {
  let localMs = LOCAL0;
  const clock = new ClockModel();
  clock.addProbe(localMs, localMs, localMs, localMs); // offset 0: server time == local time
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => CTX0 + ((localMs - LOCAL0) / 1000) * (1 + audioPpm / 1e6) });
  mapper.addSample(localMs, ctx.currentTime);
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => localMs });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(DURATION)] as const)), "t");
  return {
    ctx,
    clock,
    mapper,
    scheduler,
    get localMs() {
      return localMs;
    },
    advance(ms: number) {
      localMs += ms;
      // the engine re-samples (localNow, ctx.currentTime) with every probe; do the same
      mapper.addSample(localMs, ctx.currentTime);
    },
  };
}

const applyOpts = { trackId: "t", useOutputLatency: false };

describe("drift error", () => {
  test("is zero right after scheduling, whatever the offsets are", () => {
    for (const comp of [0, 40, -40]) {
      const rig = driftRig(0);
      const a = assignment({ compensationMs: comp });
      rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
      expect(rig.scheduler.driftErrorMs(a, false)!).toBeCloseTo(0, 9);
    }
  });

  test("a +50 ppm audio clock walks the playhead away at 0.05 ms/s, in the ahead direction", () => {
    const rig = driftRig(50);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    rig.advance(60_000); // one minute
    const err = rig.scheduler.driftErrorMs(a, false)!;
    // 50 ppm × 60 s = 3 ms, and positive means this phone is ahead
    expect(err).toBeGreaterThan(0);
    expect(err).toBeCloseTo(3, 1);
  });

  test("a nudge shows up as drift of exactly its own size", () => {
    const rig = driftRig(0);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    // +40 ms nudge = "this device is late" = it should start 40 ms earlier than it did, so relative to
    // the schedule in force it is now 40 ms behind where it ought to be.
    expect(rig.scheduler.driftErrorMs(assignment({ compensationMs: 40 }), false)!).toBeCloseTo(-40, 6);
    expect(rig.scheduler.driftErrorMs(assignment({ compensationMs: -40 }), false)!).toBeCloseTo(40, 6);
  });
});

describe("hard resync", () => {
  test("crossfades rather than stopping: the new branch fades in while the old fades out", () => {
    const rig = driftRig(50);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    const gainsAfterStart = rig.ctx.gains.length;

    rig.advance(400_000); // 50 ppm × 400 s = 20 ms, well past the threshold
    const result = rig.scheduler.checkDrift(a, false)!;
    expect(result.resynced).toBe(true);
    expect(Math.abs(result.errorMs)).toBeGreaterThan(RESYNC_THRESHOLD_MS);
    expect(rig.scheduler.lastCorrectionMs).toBeCloseTo(result.errorMs, 9);

    // a whole new branch exists (fade + pattern + 4 stems) and the fades are linear ramps of
    // RESYNC_CROSSFADE_MS in opposite directions
    expect(rig.ctx.gains.length).toBeGreaterThan(gainsAfterStart);
    const ramps = rig.ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "linearRamp"));
    const fadeIn = ramps.find((e) => e.value === 1);
    const fadeOut = ramps.find((e) => e.value === 0);
    expect(fadeIn).toBeDefined();
    expect(fadeOut).toBeDefined();
    // both ramps end at the same instant, a crossfade rather than a gap
    expect(fadeIn!.time).toBeCloseTo(fadeOut!.time, 9);
    // and that instant is RESYNC_CROSSFADE_MS after the new branch starts
    const newStart = rig.scheduler.lastDecision!.whenCtx;
    expect(fadeIn!.time - newStart).toBeCloseTo(RESYNC_CROSSFADE_MS / 1000, 9);

    // afterwards the error is back to ~0
    expect(Math.abs(rig.scheduler.driftErrorMs(a, false)!)).toBeLessThan(0.001);
  });

  test("below the threshold nothing is touched and lastCorrectionMs keeps its old value", () => {
    const rig = driftRig(50);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    const sources = rig.ctx.sources.length;
    rig.advance(100_000); // 5 ms: under the threshold
    const result = rig.scheduler.checkDrift(a, false)!;
    expect(result.resynced).toBe(false);
    expect(Math.abs(result.errorMs)).toBeLessThan(RESYNC_THRESHOLD_MS);
    expect(rig.scheduler.lastCorrectionMs).toBe(0);
    expect(rig.ctx.sources.length).toBe(sources);
  });

  test("+50 ppm over 5 minutes: bounded by the resync threshold, not by 5 ms", () => {
    // The brief asks for "within 5 ms over 5 min". With a hard resync at RESYNC_THRESHOLD_MS the error
    // necessarily sawtooths up to that threshold before anything corrects it, so the achievable bound is
    // 10 ms, not 5. This test measures the real shape; the evidence file spells out what it means and
    // what it would take to reach 5 ms (playbackRate slewing, B9e).
    const rig = driftRig(50);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);

    let worst = 0;
    const samples: number[] = [];
    for (let s = 0; s < 300; s++) {
      rig.advance(1000); // the 1 Hz drift check
      const r = rig.scheduler.checkDrift(a, false)!;
      worst = Math.max(worst, Math.abs(r.errorMs));
      samples.push(r.errorMs);
    }

    expect(worst).toBeLessThanOrEqual(RESYNC_THRESHOLD_MS + 0.2);
    expect(rig.scheduler.resyncCount).toBeGreaterThan(0);
    // and it never runs away: the last sample is small, not 15 ms of accumulated drift
    expect(Math.abs(samples[samples.length - 1]!)).toBeLessThanOrEqual(RESYNC_THRESHOLD_MS + 0.2);
    const mean = samples.reduce((x, y) => x + Math.abs(y), 0) / samples.length;
    console.log(
      `[B4] +50 ppm audio clock over 5 min: ${rig.scheduler.resyncCount} resyncs, ` +
        `worst |error| ${worst.toFixed(2)} ms, mean |error| ${mean.toFixed(2)} ms ` +
        `(threshold ${RESYNC_THRESHOLD_MS} ms — a hard-resync design cannot beat its own threshold)`,
    );
  });

  test("without correction the same drift would be 15 ms by minute five", () => {
    // The counterfactual, so the resync's value is a number and not an assertion.
    const rig = driftRig(50);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    rig.advance(300_000);
    const uncorrected = rig.scheduler.driftErrorMs(a, false)!;
    expect(uncorrected).toBeCloseTo(15, 0);
    console.log(`[B4] the same 5 minutes with the drift check disabled: ${uncorrected.toFixed(2)} ms of error`);
  });
});

describe("the system clock, by contrast, never reaches the audio", () => {
  test("+50 ppm of local clock drift is slewed out 40x faster than it accumulates", () => {
    // A phone whose system clock runs 50 ppm fast sees the server appear to fall behind by 0.05 ms/s.
    // The slew moves at 2 ms/s, so the estimate tracks it with room to spare — this is why only the
    // *audio* clock needs resyncs.
    const clock = new ClockModel();
    let local = LOCAL0;
    const ppm = 50;
    let worst = 0;
    for (let s = 0; s <= 300; s++) {
      // true offset drifts because the local clock runs fast: serverTime - localTime shrinks
      const trueOffset = -(ppm / 1e6) * (local - LOCAL0);
      const t1 = local + 10 + trueOffset;
      clock.addProbe(local, t1, t1 + 0.1, t1 + 0.1 - trueOffset + 10);
      if (clock.offsetMs !== null) worst = Math.max(worst, Math.abs(clock.offsetMs - trueOffset));
      local += 1000;
    }
    expect(worst).toBeLessThan(5);
    expect(SLEW_RATE_MS_PER_SEC / (ppm / 1000)).toBeGreaterThan(30); // 2 ms/s vs 0.05 ms/s
    console.log(`[B4] +50 ppm system-clock drift over 5 min: clock estimate stayed within ${worst.toFixed(3)} ms`);
  });
});

describe("a resumed tab drift-checks instead of restarting", () => {
  test("force on an unchanged transport crossfades only if the playhead really moved", () => {
    const rig = driftRig(0);
    const a = assignment();
    rig.scheduler.apply(playing(rig.localMs + 600), a, applyOpts);
    const sources = rig.ctx.sources.length;

    // a hidden tab that came back 2 s later with no drift: no interruption at all
    rig.advance(2000);
    const quiet = rig.scheduler.apply(playing(rig.scheduler.lastDecision ? LOCAL0 + 600 : 0), a, { ...applyOpts, force: true });
    expect(quiet.action).toBe("unchanged");
    expect(rig.ctx.sources.length).toBe(sources);

    // now a tab that was suspended long enough for the audio clock to be wrong
    const drifting = driftRig(50);
    drifting.scheduler.apply(playing(drifting.localMs + 600), a, applyOpts);
    drifting.advance(400_000);
    const recovered = drifting.scheduler.apply(playing(LOCAL0 + 600), a, { ...applyOpts, force: true });
    expect(recovered.action).toBe("restarted");
    expect(recovered.reason).toContain("drift");
  });
});
