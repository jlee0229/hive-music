/**
 * B9e: trimming `playbackRate` so audio-clock drift is absorbed instead of crossfaded.
 *
 * A phone's AudioContext clock is its audio hardware's clock, not its system clock. A crystal 50 ppm fast
 * emits 1.00005 s of content per real second: 3 ms per minute, so it crosses RESYNC_THRESHOLD_MS every
 * ~3.5 minutes and buys a 20 ms crossfade each time, forever. Slewing removes the error before it is ever
 * worth correcting — the trade every wireless multiroom system makes.
 *
 * **The simulation models the truth independently.** It integrates content consumption from the value the
 * engine actually wrote to `source.playbackRate` — the observable, not the engine's private bookkeeping —
 * and compares that against `driftErrorMs`. That independence is the point: an accounting bug in
 * `slewSec` would otherwise make the engine measure its own correction as if it were still error and
 * never converge, while reporting a healthy number. That is the P0-5 failure mode (comparing the ideal
 * against the ideal) wearing a different hat, and a simulation that used the engine's own integral would
 * reproduce it exactly.
 */
import { describe, expect, test } from "bun:test";
import {
  PLAYBACK_RATE_DEADBAND_MS, PLAYBACK_RATE_MAX_PPM, PLAYBACK_RATE_TAU_SEC, RESYNC_THRESHOLD_MS,
  type Assignment, type Transport,
} from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler } from "../scheduler";
import { FakeAudioContext, FakeBuffer, type FakeSource } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;
/** Long enough that a 50 ppm phone would resync at least once without help. */
const SIM_SECONDS = 300;

const assignment: Assignment = {
  label: "unison",
  role: "unison",
  color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0,
  compensationMs: 0,
  pattern: null,
  applyAtServerTime: null,
};
const applyOpts = { trackId: "sim", useOutputLatency: false };

interface SimResult {
  /** |engine-reported error| at each tick, ms. */
  errors: number[];
  meanAbsMs: number;
  worstAbsMs: number;
  resyncs: number;
  /** Largest disagreement between the engine's error and the independently integrated truth, ms. */
  worstTruthGapMs: number;
  ppmHistory: number[];
}

/**
 * One phone whose audio clock runs `ppmFast` parts per million fast, for `SIM_SECONDS` of wall time,
 * checked once a second (`DRIFT_CHECK_INTERVAL_MS`) — the real loop, driven by hand so 5 minutes of
 * simulated time costs 300 iterations instead of 5 minutes.
 */
function simulate(ppmFast: number, slewEnabled: boolean, jitterMs = 0): SimResult {
  const k = ppmFast / 1_000_000;
  /*
   * Optional clock-estimate noise. `now()` feeds both the mapping and `serverNow`, so jitter here is
   * exactly what a jittery NTP estimate does to the measured error — and it is the reason the loop needs
   * a deadband and τ ≥ 2 check intervals. Seeded (mulberry32) so a failure is reproducible.
   */
  let seed = 0x51e_5ee9 >>> 0; // "sleeps", roughly
  const noise = () => {
    if (jitterMs === 0) return 0;
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 2 * jitterMs;
  };
  let wall = 0; // seconds of real time since the schedule was applied

  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL); // a perfect system clock: the ONLY drift here is audio-clock
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ startTime: CTX0, clock: () => CTX0 + wall * (1 + k) });
  mapper.addSample(LOCAL, CTX0);
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL + wall * 1000 + noise() });
  scheduler.slewEnabled = slewEnabled;
  // 10 minutes of track, so nothing in this sim runs off the end
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(600)] as const)), "sim");

  const transport: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL };
  scheduler.apply(transport, assignment, applyOpts);

  /** The newest source: after a hard resync the live branch is a new set of nodes. */
  const liveSource = (): FakeSource => ctx.sources[ctx.sources.length - 1]!;
  const rateNow = (): number => liveSource().playbackRate.value;

  // Truth: content-seconds this phone has emitted, integrated from the param values the engine wrote.
  let content = liveSource().starts[0]!.offset;
  /** Wall time at which that content value is true — a start is armed slightly in the future. */
  let contentAtWall = wall + (liveSource().starts[0]!.when - ctx.currentTime) / (1 + k);
  let lastWall = wall;
  let resyncs = 0;
  let worstTruthGapMs = 0;
  const errors: number[] = [];
  const ppmHistory: number[] = [];

  for (let tick = 0; tick < SIM_SECONDS; tick++) {
    const rate = rateNow(); // in effect for the second we are about to advance through
    wall += 1;
    // content per wall second = rate (content per ctx second) × ctx seconds per wall second, integrated
    // only over the part of this second in which the source was actually running
    content += rate * (1 + k) * Math.max(0, wall - Math.max(lastWall, contentAtWall));
    lastWall = wall;

    const before = scheduler.resyncCount;
    const drift = scheduler.checkDrift(assignment, false);
    expect(drift).not.toBeNull();

    if (scheduler.resyncCount === before) {
      // idealContent at wall t is simply t: track zero is at serverTime LOCAL and compensation is 0
      const trueErrorMs = (content - wall) * 1000;
      worstTruthGapMs = Math.max(worstTruthGapMs, Math.abs(trueErrorMs - drift!.errorMs));
      errors.push(Math.abs(drift!.errorMs));
      ppmHistory.push(scheduler.lastSlewPpm);
    } else {
      // A hard resync replaces the branch; re-derive the truth from the new source's start call.
      resyncs++;
      const start = liveSource().starts[0]!;
      content = start.offset;
      contentAtWall = wall + (start.when - ctx.currentTime) / (1 + k);
      lastWall = wall;
      errors.push(Math.abs(drift!.errorMs));
      ppmHistory.push(0);
    }
  }

  return {
    errors,
    meanAbsMs: errors.reduce((a, b) => a + b, 0) / errors.length,
    worstAbsMs: Math.max(...errors),
    resyncs,
    worstTruthGapMs,
    ppmHistory,
  };
}

describe("5 minutes on a +50 ppm audio clock", () => {
  test("slewing holds the error near zero with no hard resync, and the accounting is honest", () => {
    const on = simulate(50, true);
    console.log(
      `[B9e] slew ON  · mean |err| ${on.meanAbsMs.toFixed(3)} ms · worst ${on.worstAbsMs.toFixed(3)} ms · ` +
        `resyncs ${on.resyncs} · trim ${Math.min(...on.ppmHistory)}…${Math.max(...on.ppmHistory)} ppm · ` +
        `truth gap ≤ ${on.worstTruthGapMs.toFixed(6)} ms`,
    );

    // the gate the orchestrator set for defaulting this ON
    expect(on.meanAbsMs).toBeLessThan(3);
    expect(on.worstAbsMs).toBeLessThan(5);
    expect(on.resyncs).toBe(0);

    // the engine's reported error matches the independently integrated truth
    expect(on.worstTruthGapMs).toBeLessThan(0.01);
    // and it stayed well inside the cap: 50 ppm of drift needs nowhere near 500 ppm of correction
    expect(Math.max(...on.ppmHistory.map(Math.abs))).toBeLessThanOrEqual(PLAYBACK_RATE_MAX_PPM);
  });

  test("without slewing the same phone crossfades — which is what this is for", () => {
    const off = simulate(50, false);
    console.log(
      `[B9e] slew OFF · mean |err| ${off.meanAbsMs.toFixed(3)} ms · worst ${off.worstAbsMs.toFixed(3)} ms · ` +
        `resyncs ${off.resyncs}`,
    );
    expect(off.resyncs).toBeGreaterThanOrEqual(1);
    expect(off.worstAbsMs).toBeGreaterThan(RESYNC_THRESHOLD_MS);
    // and it is a *quantitative* improvement, not just fewer events
    const on = simulate(50, true);
    expect(on.meanAbsMs).toBeLessThan(off.meanAbsMs / 5);
  });

  test("a slow clock is corrected in the other direction", () => {
    const slow = simulate(-50, true);
    console.log(`[B9e] slew ON (−50 ppm) · mean |err| ${slow.meanAbsMs.toFixed(3)} ms · resyncs ${slow.resyncs}`);
    expect(slow.resyncs).toBe(0);
    expect(slow.meanAbsMs).toBeLessThan(3);
    // a phone that is behind must be sped up
    expect(Math.max(...slow.ppmHistory)).toBeGreaterThan(0);
    expect(Math.min(...slow.ppmHistory)).toBeGreaterThanOrEqual(0);
  });

  test("a jittery clock estimate does not make the loop hunt (the deadband earns its keep)", () => {
    // ±1 ms of noise on the clock estimate is pessimistic for a room on one AP; the loop must stay
    // bounded rather than chase it. Proportional control at τ = 2 ticks gives e_{n+1} = ½e_n − ½w_n,
    // an AR(1) whose standard deviation is ~0.58× the noise — bounded, not a random walk.
    const noisy = simulate(50, true, 1);
    console.log(
      `[B9e] slew ON (+50 ppm, ±1 ms clock jitter) · mean |err| ${noisy.meanAbsMs.toFixed(3)} ms · ` +
        `worst ${noisy.worstAbsMs.toFixed(3)} ms · resyncs ${noisy.resyncs}`,
    );
    expect(noisy.resyncs).toBe(0);
    expect(noisy.meanAbsMs).toBeLessThan(3);
    expect(noisy.worstAbsMs).toBeLessThan(5);
    // it is still correcting the underlying drift, not just averaging noise: the trim is mostly negative
    const negatives = noisy.ppmHistory.filter((p) => p < 0).length;
    expect(negatives).toBeGreaterThan(noisy.ppmHistory.filter((p) => p > 0).length);
  });

  test("a clock beyond the cap still crossfades, and slewing does not hide that", () => {
    // 900 ppm is nearly twice the 500 ppm cap, so the correction cannot keep up. The honest outcome is
    // "fewer crossfades, not none" — the failure mode to avoid is an error that grows while the engine
    // reports itself healthy, so the truth gap is asserted here too.
    const on = simulate(900, true);
    const off = simulate(900, false);
    console.log(
      `[B9e] slew ON (+900 ppm, past the cap) · worst ${on.worstAbsMs.toFixed(3)} ms · ` +
        `resyncs ${on.resyncs} vs ${off.resyncs} without slewing`,
    );
    expect(on.resyncs).toBeGreaterThan(0); // slewing is not magic
    expect(on.resyncs).toBeLessThan(off.resyncs); // but it is strictly better
    expect(on.worstTruthGapMs).toBeLessThan(0.01);
  });
});

describe("the control law", () => {
  function fixedRig() {
    let wall = 0;
    const clock = new ClockModel();
    clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL);
    const mapper = new CtxMapper(clock);
    const ctx = new FakeAudioContext({ startTime: CTX0, clock: () => CTX0 + wall });
    mapper.addSample(LOCAL, CTX0);
    const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL + wall * 1000 });
    scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(600)] as const)), "sim");
    scheduler.apply({ state: "playing", serverTimeAtTrackZero: LOCAL }, assignment, applyOpts);
    return { scheduler, ctx, advance: (sec: number) => (wall += sec) };
  }

  test("inside the deadband the rate is exactly 1, not merely close", () => {
    const { scheduler, ctx } = fixedRig();
    // nudge the phone's playhead by less than the deadband via a compensation change
    const small: Assignment = { ...assignment, compensationMs: PLAYBACK_RATE_DEADBAND_MS / 2 };
    scheduler.checkDrift(small, false);
    for (const s of ctx.sources) expect(s.playbackRate.value).toBe(1);
    expect(scheduler.lastSlewPpm).toBe(0);
  });

  test("the trim is proportional, opposes the error, and saturates at the cap", () => {
    for (const errMs of [1, 2, 5, 9]) {
      const { scheduler, ctx } = fixedRig();
      // compensationMs positive means "this phone is late, play it earlier", which shows up as the phone
      // being BEHIND the timeline once applied — so use it to inject a known signed error.
      scheduler.checkDrift({ ...assignment, compensationMs: errMs }, false);
      const expected = Math.max(
        -PLAYBACK_RATE_MAX_PPM,
        Math.min(PLAYBACK_RATE_MAX_PPM, (scheduler.lastDriftErrorMs * -1000) / PLAYBACK_RATE_TAU_SEC),
      );
      expect(scheduler.lastSlewPpm).toBeCloseTo(expected, 6);
      // sign: an error of either sign is opposed
      expect(Math.sign(scheduler.lastSlewPpm)).toBe(-Math.sign(scheduler.lastDriftErrorMs));
      const rate = ctx.sources[ctx.sources.length - 1]!.playbackRate.value;
      expect(rate).toBeCloseTo(1 + expected / 1_000_000, 12);
    }
  });

  test("slewEnabled = false leaves playbackRate untouched", () => {
    const { scheduler, ctx } = fixedRig();
    scheduler.slewEnabled = false;
    scheduler.checkDrift({ ...assignment, compensationMs: 4 }, false);
    for (const s of ctx.sources) expect(s.playbackRate.events).toHaveLength(0);
    expect(scheduler.lastSlewPpm).toBe(0);
  });

  test("a hard resync starts the new branch at rate 1", () => {
    const { scheduler, ctx } = fixedRig();
    scheduler.checkDrift({ ...assignment, compensationMs: 4 }, false); // a trim is now in effect
    expect(scheduler.lastSlewPpm).not.toBe(0);
    const before = ctx.sources.length;
    const res = scheduler.checkDrift({ ...assignment, compensationMs: 200 }, false); // way past the threshold
    expect(res!.resynced).toBe(true);
    expect(ctx.sources.length).toBeGreaterThan(before);
    expect(scheduler.lastSlewPpm).toBe(0);
    expect(ctx.sources[ctx.sources.length - 1]!.playbackRate.value).toBe(1);
  });
});
