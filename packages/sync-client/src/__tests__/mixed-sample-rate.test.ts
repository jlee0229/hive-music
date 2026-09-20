/**
 * A "demo-light" fixture (22.05 kHz stems, so a phone on venue wifi finishes downloading) played on a
 * 48 kHz AudioContext. The question worth answering before anyone generates that fixture: does a stem
 * whose file rate differs from the context rate move the engine's timing?
 *
 * It does not, and the reason is worth writing down rather than trusting: `decodeAudioData` resamples to
 * `ctx.sampleRate` at decode time, and every number the scheduler works in is **seconds** —
 * `buffer.duration`, `ctx.currentTime`, `start(when, offset)`. Sample counts never enter the scheduling
 * math. `durationSec` comes from the decoded buffer, not from the track metadata, so it is the resampled
 * length by construction.
 *
 * These tests pin that as a property (identical decisions at three rates) instead of an anecdote, because
 * the failure it guards against is silent: a rate-dependent constant would put every phone in the room
 * off by the same amount, which is exactly the error a room cannot hear.
 */
import { describe, expect, test } from "bun:test";
import type { Assignment, Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { LATE_START_MARGIN_SEC, Scheduler } from "../scheduler";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;
const DURATION_SEC = 30;

const assignment: Assignment = {
  label: "unison",
  role: "unison",
  color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0,
  compensationMs: 25,
  pattern: null,
  applyAtServerTime: null,
};

/**
 * `ctxRate` is the device's context. `bufferRate` is the rate the decoded buffer *reports*; in a browser
 * that always equals `ctxRate`, and the mismatched pairs below are deliberate — they prove nothing in the
 * scheduling path reads it.
 */
function rig(ctxRate: number, bufferRate: number) {
  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL);
  const mapper = new CtxMapper(clock);
  mapper.addSample(LOCAL, CTX0);
  const ctx = new FakeAudioContext({ startTime: CTX0, sampleRate: ctxRate });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(DURATION_SEC, bufferRate)] as const)), "synthetic-30s-lite");
  return { ctx, scheduler };
}

const applyOpts = { trackId: "synthetic-30s-lite", useOutputLatency: false };

describe("a 22.05 kHz fixture on a 48 kHz context", () => {
  test("the scheduled ctx time and offset are identical at 22.05, 44.1 and 48 kHz", () => {
    const transport: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL - 7_000 };
    const results = [22_050, 44_100, 48_000].map((rate) => {
      const { ctx, scheduler } = rig(rate, rate);
      scheduler.apply(transport, assignment, applyOpts);
      const src = ctx.sources[0]!;
      return { rate, when: src.starts[0]!.when, offset: src.starts[0]!.offset, startCtxForZero: scheduler.startCtxForZero };
    });
    for (const r of results.slice(1)) {
      expect(r.when).toBeCloseTo(results[0]!.when, 9);
      expect(r.offset!).toBeCloseTo(results[0]!.offset!, 9);
      expect(r.startCtxForZero!).toBeCloseTo(results[0]!.startCtxForZero!, 9);
    }
    // and the numbers are the right ones, not merely equal to each other: 7 s into the track, advanced
    // by 25 ms of compensation, plus the margin a mid-track start needs to arm the source
    expect(results[0]!.offset!).toBeCloseTo(7 + 0.025 + LATE_START_MARGIN_SEC, 6);
  });

  test("durationSec follows the decoded buffer, so the late-join guard uses real seconds", () => {
    // The pathological case: a phone whose context runs at 48 kHz decoding a 22.05 kHz file. A scheduler
    // that mistook frames for seconds would think this track is 30 · 48000/22050 ≈ 65 s long and would
    // happily start a phone 40 s into a 30 s track.
    const { scheduler } = rig(48_000, 22_050);
    const past: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL - 40_000 };
    const result = scheduler.apply(past, assignment, applyOpts);
    expect(result.action).toBe("finished"); // past the end of a 30 s track: nothing to play
    expect(result.decision).toBeNull();
  });

  test("a mid-track start lands at the same wall-clock instant regardless of file rate", () => {
    const transport: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL - 12_345 };
    const lite = rig(48_000, 22_050);
    const full = rig(48_000, 48_000);
    lite.scheduler.apply(transport, assignment, applyOpts);
    full.scheduler.apply(transport, assignment, applyOpts);
    const a = lite.ctx.sources[0]!.starts[0]!;
    const b = full.ctx.sources[0]!.starts[0]!;
    expect(a.when).toBeCloseTo(b.when, 9);
    expect(a.offset!).toBeCloseTo(b.offset!, 9);
    expect(a.offset!).toBeCloseTo(12.345 + 0.025 + LATE_START_MARGIN_SEC, 6);
  });
});
