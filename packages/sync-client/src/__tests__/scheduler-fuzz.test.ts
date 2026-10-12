/**
 * Scheduler invariants under long random sequences. This is the test that found ENGINE-SYNC-06 (pattern
 * curves refused by Web Audio), -07 (a waiting branch cannot be corrected) and -08 (a stop inside a
 * crossfade leaves the retiring branch sounding); it passes only with all three fixed.
 *
 * Every other scheduler test asserts one scenario. This one drives `Scheduler.apply()` with thousands of
 * random operations on simulated time — play, pause, seek, stop, track advance with a long lead, gain /
 * pattern / delay / compensation changes, a null assignment, buffer swaps, mute, frozen tabs, clock
 * steps, an audio clock that runs fast or slow — with the scheduler's own timers running, and checks
 * after every step the things that must hold whatever the sequence was:
 *
 *  1. never two copies of a stem sounding, except for one crossfade's worth of overlap;
 *  2. nothing is ever started in the past, at a negative offset, or beyond the end of its buffer;
 *  3. what is actually sounding (integrating every playbackRate step) is where the timeline says the
 *     music should be, within the resync threshold once the scheduler has had time to react;
 *  4. every gain value written is finite and within [0, 1];
 *  5. no timer is left armed when nothing is playing;
 *  6. after a stop, everything really stops.
 *
 * A failure prints the seed and the last operations; `FUZZ_SEED=<n>` replays one seed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RESYNC_CROSSFADE_MS, RESYNC_THRESHOLD_MS, type Assignment, type Pattern, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler, STOP_FADE_SEC } from "../scheduler";
import { makeAssignment, STEMS } from "./engine-rig";
import { FakeAudioContext, FakeBuffer, FakeParam, type FakeSource } from "./fake-audio";
import { rng, VirtualTime } from "./sim";

const LOCAL0 = 1_700_000_000_000;
const CTX0 = 5;

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
  FakeParam.strictCurves = true;
});
afterEach(() => {
  vt.uninstall();
  FakeParam.strictCurves = false;
});

interface World {
  transport: Transport;
  assignment: Assignment | null;
  trackId: string;
  durationSec: number;
  useOutputLatency: boolean;
  muted: boolean;
}

function fuzzOne(seed: number, ops: number): { curveRejections: number; resyncs: number; steps: number } {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const log: string[] = [];
  const fail = (what: string): never => {
    throw new Error(`fuzz seed ${seed}: ${what}\n  last ops:\n    ${log.slice(-12).join("\n    ")}`);
  };

  // ---- the two clocks the scheduler lives between -------------------------------------------------
  const audioPpm = between(-150, 150);
  let trueOffset = between(-5000, 5000); // serverTime − localTime
  const localMs = (): number => LOCAL0 + vt.nowMs;
  const serverNowTrue = (): number => localMs() + trueOffset;
  const clock = new ClockModel();
  const feedClock = (): void => {
    const t = localMs();
    clock.addProbe(t, t + trueOffset, t + trueOffset, t); // an exact, zero-RTT probe
  };
  feedClock();
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => CTX0 + (vt.nowMs / 1000) * (1 + audioPpm / 1e6) });
  ctx.state = "running"; // the drift check stands down on a context that is not (ENGINE-SYNC-18)
  ctx.outputLatency = pick([0, 0.012, 0.04]);
  const scheduler = new Scheduler({ ctx, clock, mapper, now: localMs });

  const stemOf = new Map<unknown, string>();
  const makeBuffers = (durationSec: number): Map<string, FakeBuffer> => {
    const m = new Map<string, FakeBuffer>();
    for (const stem of STEMS) {
      const b = new FakeBuffer(durationSec);
      stemOf.set(b, stem);
      m.set(stem, b);
    }
    return m;
  };

  const w: World = {
    transport: { state: "stopped" },
    assignment: makeAssignment(),
    trackId: "t0",
    durationSec: 40,
    useOutputLatency: false,
    muted: false,
  };
  scheduler.setBuffers(makeBuffers(w.durationSec), w.trackId);

  /** Local time before which the position check is suspended: the scheduler is allowed time to react. */
  let settleUntil = 0;
  const disturb = (ms = 2500): void => {
    settleUntil = Math.max(settleUntil, vt.nowMs + ms);
  };
  let stoppedAtCtx: number | null = null;

  const apply = (force = false): void => {
    scheduler.apply(w.transport, w.assignment, { trackId: w.trackId, useOutputLatency: w.useOutputLatency, force });
    // Silence is owed from the moment the room stops or this device stops being a speaker.
    const silent = w.transport.state !== "playing" || w.assignment === null;
    if (!silent) stoppedAtCtx = null;
    else stoppedAtCtx ??= ctx.currentTime;
  };

  const randomPattern = (): Pattern | null =>
    pick<Pattern | null>([
      null,
      null,
      { kind: "strobe", periodMs: pick([250, 500, 1000, 2000]), phaseMs: Math.round(between(0, 500)), duty: pick([0.25, 0.5]), rampMs: 10 },
      { kind: "wave", periodMs: 2000, phaseMs: Math.round(between(0, 2000)) },
    ]);

  const randomAssignment = (): Assignment =>
    makeAssignment({
      gainsDb: Object.fromEntries(STEMS.map((s) => [s, pick([0, 0, -6, -60])])),
      delayMs: pick([0, 0, 0, Math.round(between(0, 300))]),
      compensationMs: pick([0, 25, 45, 60, Math.round(between(-20, 100))]),
      pattern: randomPattern(),
      applyAtServerTime: rand() < 0.3 ? serverNowTrue() + between(-200, 800) : null,
    });

  // ---- invariants ---------------------------------------------------------------------------------
  /** Music sources that have not finished yet — the only ones any invariant can still be about. */
  let active: FakeSource[] = [];
  let checkedSources = 0;
  const gainCursor = new Map<unknown, number>();

  const check = (): void => {
    const now = ctx.currentTime;

    // 2. every start is in the future, at a sane offset
    const all = ctx.sources;
    for (; checkedSources < all.length; checkedSources++) {
      const s = all[checkedSources]!;
      if (s.starts.length !== 1) fail(`a source was started ${s.starts.length} times`);
      const { when, offset } = s.starts[0]!;
      if (!Number.isFinite(when) || !Number.isFinite(offset)) fail(`start(${when}, ${offset}) is not finite`);
      if (when < s.startCalledAtCtx[0]! - 1e-9) fail(`start scheduled ${(s.startCalledAtCtx[0]! - when) * 1000} ms in the past`);
      if (offset < 0) fail(`negative start offset ${offset}`);
      if (offset >= s.buffer!.duration) fail(`start offset ${offset} beyond the buffer (${s.buffer!.duration} s)`);
      if (stemOf.has(s.buffer)) active.push(s);
    }
    active = active.filter((s) => s.endsAt > now - 1);

    // 4. gains: finite, in range
    for (let i = Math.max(0, ctx.gains.length - 40); i < ctx.gains.length; i++) {
      const g = ctx.gains[i]!; // only the newest few branches' nodes can still be receiving events
      const events = g.gain.events;
      for (let k = gainCursor.get(g) ?? 0; k < events.length; k++) {
        const e = events[k]!;
        if (!Number.isFinite(e.time)) fail(`gain event at non-finite time (${e.kind})`);
        if (e.value !== undefined && !(e.value >= 0 && e.value <= 1 + 1e-9)) fail(`gain ${e.kind} value ${e.value} out of range`);
        if (e.curve) for (const v of e.curve) if (!(v >= 0 && v <= 1 + 1e-9)) fail(`pattern curve value ${v} out of range`);
      }
      gainCursor.set(g, events.length);
    }
    // the master gain (node 0) lives for the whole run
    for (const e of ctx.gains[0]!.gain.events.slice(-2)) if (!(e.value === 0 || e.value === 1)) fail(`master gain target ${e.value}`);

    // 1. at most one copy of each stem, bar one crossfade
    const live = active.filter((s) => s.liveAt(now));
    const byStem = new Map<string, FakeSource[]>();
    for (const s of live) {
      const stem = stemOf.get(s.buffer)!;
      byStem.set(stem, [...(byStem.get(stem) ?? []), s]);
    }
    for (const [stem, list] of byStem) {
      if (list.length > 2) fail(`${list.length} copies of '${stem}' sounding at once`);
      if (list.length === 2) {
        const [older, newer] = list[0]!.starts[0]!.when <= list[1]!.starts[0]!.when ? [list[0]!, list[1]!] : [list[1]!, list[0]!];
        const overlap = older.endsAt - newer.starts[0]!.when;
        if (overlap > RESYNC_CROSSFADE_MS / 1000 + 1e-6) fail(`${stem} doubled for ${(overlap * 1000).toFixed(1)} ms: ${active.filter((s) => stemOf.get(s.buffer) === stem).slice(-4).map((s) => `[${((s.starts[0]!.when - now) * 1000).toFixed(1)}..${((s.endsAt - now) * 1000).toFixed(1)}]`).join(" ")}`);
      }
    }

    // 5. no timers when nothing is playing
    if (!scheduler.playing && vt.pendingIntervals !== 0) fail(`${vt.pendingIntervals} interval(s) armed while not playing`);
    if (vt.pendingIntervals > 2) fail(`${vt.pendingIntervals} intervals armed (drift + pattern is the most there can be)`);

    // 6. a stop really stops
    if (stoppedAtCtx !== null && now > stoppedAtCtx + STOP_FADE_SEC + 1e-6) {
      if (live.length > 0) fail(`${live.length} source(s) still sounding ${((now - stoppedAtCtx) * 1000).toFixed(0)} ms after a stop`);
    }

    // 3. what is sounding is where the timeline says
    if (w.transport.state === "playing" && w.assignment !== null && vt.nowMs >= settleUntil) {
      const a = w.assignment;
      const olMs = w.useOutputLatency ? ctx.outputLatency * 1000 : 0;
      // track position that should be leaving the speaker now
      const ideal = (serverNowTrue() - w.transport.serverTimeAtTrackZero - a.delayMs + a.compensationMs + olMs) / 1000;
      if (ideal > 0.2 && ideal < w.durationSec - 0.2) {
        if (live.length !== STEMS.length) fail(`${live.length} sources sounding at track position ${ideal.toFixed(2)} s, expected ${STEMS.length}`);
        for (const s of live) {
          const errMs = (s.contentPositionAt(now) - ideal) * 1000;
          if (Math.abs(errMs) > RESYNC_THRESHOLD_MS + 1) fail(`playhead ${errMs.toFixed(2)} ms off the timeline (settled) [sched drift ${scheduler.lastDriftErrorMs.toFixed(2)} resyncs ${scheduler.resyncCount} ideal ${ideal.toFixed(3)} when ${s.starts[0]!.when.toFixed(3)} off ${s.starts[0]!.offset.toFixed(3)} now ${now.toFixed(3)} useOL ${w.useOutputLatency} a ${JSON.stringify([a.delayMs,a.compensationMs])}]`);
        }
      } else if (ideal > w.durationSec + 0.2 && live.length > 0) {
        fail(`${live.length} source(s) sounding ${(ideal - w.durationSec).toFixed(2)} s past the end of the track`);
      }
    }
    // the scheduler's own view agrees that it is not NaN-poisoned
    if (!Number.isFinite(scheduler.lastDriftErrorMs)) fail("lastDriftErrorMs is not finite");
  };

  const run = (ms: number): void => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(100, left);
      const beforeSec = Math.floor(vt.nowMs / 1000);
      vt.advance(step);
      left -= step;
      if (Math.floor(vt.nowMs / 1000) !== beforeSec) {
        feedClock(); // the engine probes at 1 Hz and samples the mapper with each probe
        mapper.addSample(localMs(), ctx.currentTime);
      }
      check();
    }
  };

  // ---- the operations -----------------------------------------------------------------------------
  const playFrom = (positionSec: number, leadMs = 600): void => {
    w.transport = { state: "playing", serverTimeAtTrackZero: serverNowTrue() + leadMs - positionSec * 1000 };
  };

  for (let i = 0; i < ops; i++) {
    const r = rand();
    if (r < 0.14) {
      const from = rand() < 0.5 ? 0 : between(0, w.durationSec * 1.05);
      playFrom(from);
      log.push(`${vt.nowMs} play from ${from.toFixed(2)}`);
      apply();
      disturb();
    } else if (r < 0.2) {
      w.transport = { state: "paused", trackTimeAtPause: 1 };
      log.push(`${vt.nowMs} pause`);
      apply();
    } else if (r < 0.24) {
      w.transport = { state: "stopped" };
      log.push(`${vt.nowMs} stop`);
      apply();
    } else if (r < 0.3) {
      // playlist advance: a new track and a start ~5 s ahead, in one snapshot
      w.trackId = `t${i}`;
      w.durationSec = pick([8, 20, 40]);
      scheduler.setBuffers(makeBuffers(w.durationSec), w.trackId);
      playFrom(0, 5000);
      log.push(`${vt.nowMs} advance to ${w.trackId} (${w.durationSec} s)`);
      apply(true);
      disturb(5500);
    } else if (r < 0.5) {
      w.assignment = randomAssignment();
      log.push(`${vt.nowMs} assignment delay ${w.assignment.delayMs} comp ${w.assignment.compensationMs} pattern ${w.assignment.pattern?.kind ?? "none"}`);
      apply();
      disturb();
    } else if (r < 0.53) {
      w.assignment = null;
      log.push(`${vt.nowMs} assignment null`);
      apply();
    } else if (r < 0.58) {
      // CHOIR: same track, same length, different audio
      scheduler.setBuffers(makeBuffers(w.durationSec), w.trackId);
      log.push(`${vt.nowMs} buffer swap`);
      apply(true);
      disturb(200);
    } else if (r < 0.63) {
      w.muted = !w.muted;
      scheduler.setMuted(w.muted);
      log.push(`${vt.nowMs} mute ${w.muted}`);
    } else if (r < 0.68) {
      // a frozen tab: time passes, no timer fires, then the page comes back and forces a re-check
      const ms = between(200, 8000);
      vt.freeze(ms);
      feedClock();
      mapper.addSample(localMs(), ctx.currentTime);
      log.push(`${vt.nowMs} thawed after ${ms.toFixed(0)} ms`);
      apply(true);
      disturb();
    } else if (r < 0.73) {
      const step = pick([-1, 1]) * between(3, 400);
      trueOffset += step;
      feedClock();
      log.push(`${vt.nowMs} clock step ${step.toFixed(1)} ms`);
      disturb(12_000); // a sub-threshold step is slewed at 2 ms/s by the clock, then 0.5 ms/s by the rate trim
    } else if (r < 0.77) {
      w.useOutputLatency = !w.useOutputLatency;
      log.push(`${vt.nowMs} useOutputLatency ${w.useOutputLatency}`);
      apply();
      disturb();
    } else if (r < 0.8) {
      ctx.outputLatency = pick([0.012, 0.04, 0.19]); // (a later 0 is held at the last good value: see ENGINE-SYNC-04)
      log.push(`${vt.nowMs} outputLatency ${ctx.outputLatency}`);
      disturb(3000);
    } else if (r < 0.9) {
      log.push(`${vt.nowMs} snapshot (unchanged)`);
      apply();
    } else {
      log.push(`${vt.nowMs} forced re-check`);
      apply(true);
    }
    check();
    run(pick([20, 100, 500, 500, 1500, 4000, between(0, 12_000)]));
  }

  // The end of every run: stop, and prove nothing is left behind.
  w.transport = { state: "stopped" };
  apply();
  run(500);
  if (vt.pending !== 0) fail(`${vt.pending} timer(s) left after the final stop`);
  if (ctx.sources.some((s) => stemOf.has(s.buffer) && s.liveAt(ctx.currentTime))) fail("a source survived the final stop");
  const master = ctx.gains[0]!;
  const lastMute = master.gain.events.filter((e) => e.kind === "setTarget").at(-1);
  if (lastMute && lastMute.value !== (w.muted ? 0 : 1)) fail("master gain does not match the mute state");

  const curveRejections = ctx.gains.reduce((n, g) => n + g.gain.curveRejections, 0);
  scheduler.dispose();
  return { curveRejections, resyncs: scheduler.resyncCount, steps: clock.stepsDetected };
}

describe("scheduler invariants under fuzz", () => {
  const only = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : null;
  const seeds = only ?? Array.from({ length: 150 }, (_, i) => i + 1);

  test(`${seeds.length} seeds × 300 operations hold every invariant`, () => {
    let rejections = 0;
    for (const seed of seeds) {
      rejections += fuzzOne(seed, 300).curveRejections;
      vt.uninstall();
      vt = new VirtualTime().install();
    }
    // No pattern window may be refused by Web Audio for overlapping the one before it: the scheduler
    // swallows that throw, and the listener hears a strobe stuck on or off for 200 ms.
    expect(rejections).toBe(0);
  }, 120_000);
});
