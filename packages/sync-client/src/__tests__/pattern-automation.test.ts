/**
 * ENGINE-SYNC-06 · STROBE and WAVE gain automation, checked against the rule real Web Audio enforces.
 *
 * `setValueCurveAtTime` throws when the new curve overlaps one already scheduled, and the scheduler
 * swallows that throw. The fake context never threw, so nothing here could see what a browser does.
 * `FakeParam.strictCurves` now applies the browser's rule, and what it showed was confirmed against a
 * real AudioContext in headless Chromium (numbers in the findings file):
 *
 *  - every 100 ms tick wrote a fresh 200 ms window starting where the last one ended, so the written
 *    curve ran ahead of the music at twice real time — a minute in, a minute of the current pattern was
 *    already scheduled;
 *  - a change of pattern therefore had nowhere to go: every new curve overlapped an old one and was
 *    refused, and the phone kept the old pattern for as long as the song had been playing;
 *  - even with nothing changing, windows that merely touched were refused whenever float rounding fell
 *    the wrong way (one in nine in Chrome), each leaving the gain un-automated for that stretch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { evaluatePattern, type Pattern, type Transport } from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import {
  PATTERN_CURVE_GAP_SEC, PATTERN_LOOKAHEAD_MS, PATTERN_TICK_MS, Scheduler,
} from "../scheduler";
import { makeAssignment, STEMS } from "./engine-rig";
import { FakeAudioContext, FakeBuffer, FakeParam, type FakeGain, type ParamEvent } from "./fake-audio";
import { VirtualTime } from "./sim";

const LOCAL0 = 1_700_000_000_000;
const CTX0 = 5;
const applyOpts = { trackId: "t", useOutputLatency: false };

const STROBE_A: Pattern = { kind: "strobe", periodMs: 500, phaseMs: 0, duty: 0.5, rampMs: 10 };
const STROBE_B: Pattern = { kind: "strobe", periodMs: 1500, phaseMs: 333, duty: 0.25, rampMs: 10 };
const WAVE: Pattern = { kind: "wave", periodMs: 2000, phaseMs: 700 };

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
  FakeParam.strictCurves = true;
});
afterEach(() => {
  vt.uninstall();
  FakeParam.strictCurves = false;
});

function rig(pattern: Pattern | null) {
  const localMs = (): number => LOCAL0 + vt.nowMs;
  const clock = new ClockModel();
  clock.addProbe(LOCAL0, LOCAL0, LOCAL0, LOCAL0);
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ clock: () => CTX0 + vt.nowMs / 1000 });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: localMs });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(600)] as const)), "t");
  const transport: Transport = { state: "playing", serverTimeAtTrackZero: LOCAL0 + 600 };
  const setPattern = (p: Pattern | null): void => void scheduler.apply(transport, makeAssignment({ pattern: p }), applyOpts);
  setPattern(pattern);
  /** The pattern gain of the one branch these tests build: master, then fade, then pattern. */
  const patternGain = (): FakeGain => ctx.gains[2]!;
  /** Track position sounding at ctx time `t`, ms (the branch starts at ctx 5.6 from position 0). */
  const positionMsAt = (t: number): number => (t - (CTX0 + 0.6)) * 1000;
  return { ctx, scheduler, setPattern, patternGain, positionMsAt };
}

/** Curve events still in force, after applying every cancelScheduledValues in order. */
function liveCurves(param: FakeParam): ParamEvent[] {
  let live: ParamEvent[] = [];
  for (const e of param.events) {
    if (e.kind === "cancel") live = live.filter((x) => x.kind !== "setValueCurve" || x.time + x.duration! <= e.time);
    else if (e.kind === "setValueCurve") live.push(e);
  }
  return live;
}

const rejections = (ctx: FakeAudioContext): number => ctx.gains.reduce((n, g) => n + g.gain.curveRejections, 0);

/** Every sample of every curve in `events` is the pattern evaluated at the position sounding then. */
function expectCurvesFollow(events: ParamEvent[], pattern: Pattern, positionMsAt: (t: number) => number): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    const n = e.curve!.length;
    for (let i = 0; i < n; i++) {
      const t = e.time + (e.duration! * i) / (n - 1);
      expect(e.curve![i]!).toBeCloseTo(evaluatePattern(pattern, positionMsAt(t)), 5);
    }
  }
}

describe("ENGINE-SYNC-06 · the pattern curve is topped up, not piled up", () => {
  test("two minutes of STROBE: the written horizon never passes the look-ahead, and nothing is refused", () => {
    const r = rig(STROBE_A);
    let worstHorizon = 0;
    for (let i = 0; i < 1200; i++) {
      vt.advance(100);
      const curves = liveCurves(r.patternGain().gain);
      const end = Math.max(...curves.map((e) => e.time + e.duration!));
      // measured from the playhead, or from the start instant while the start is still ahead
      worstHorizon = Math.max(worstHorizon, end - Math.max(r.ctx.currentTime, CTX0 + 0.6));
      // …and never falls behind: the gain is under automation right now
      expect(end).toBeGreaterThan(r.ctx.currentTime);
    }
    expect(worstHorizon).toBeLessThanOrEqual((PATTERN_LOOKAHEAD_MS + PATTERN_TICK_MS) / 1000 + 1e-9);
    expect(rejections(r.ctx)).toBe(0);
    expect(r.scheduler.patternCurveRejections).toBe(0);
  });

  test("consecutive curves are laid end to end with a gap: they never touch, and never leave a hole", () => {
    const r = rig(WAVE);
    vt.advance(30_000);
    const curves = liveCurves(r.patternGain().gain).sort((a, b) => a.time - b.time);
    expect(curves.length).toBeGreaterThan(250);
    for (let i = 1; i < curves.length; i++) {
      const gap = curves[i]!.time - (curves[i - 1]!.time + curves[i - 1]!.duration!);
      expect(gap).toBeGreaterThanOrEqual(PATTERN_CURVE_GAP_SEC * 0.999);
      expect(gap).toBeLessThan(0.001);
    }
    expectCurvesFollow(curves, WAVE, r.positionMsAt);
  });
});

describe("ENGINE-SYNC-06 · a change of pattern takes effect now", () => {
  for (const [name, from, to] of [
    ["STROBE → a different STROBE (the host changes the note division)", STROBE_A, STROBE_B],
    ["WAVE → STROBE", WAVE, STROBE_A],
    ["STROBE → WAVE", STROBE_B, WAVE],
  ] as const) {
    test(`${name}, 45 s into the song`, () => {
      const r = rig(from);
      vt.advance(45_000);
      const changedAt = r.ctx.currentTime;
      r.setPattern(to);
      vt.advance(5000);

      const after = liveCurves(r.patternGain().gain)
        .filter((e) => e.time + e.duration! > changedAt)
        .sort((a, b) => a.time - b.time);
      // the new pattern owns the gain from the instant of the change…
      expect(after[0]!.time).toBeCloseTo(changedAt, 9);
      // …continuously…
      for (let i = 1; i < after.length; i++) {
        expect(after[i]!.time - (after[i - 1]!.time + after[i - 1]!.duration!)).toBeLessThan(0.001);
      }
      // …and every value written is the NEW pattern at the position that will be sounding
      expectCurvesFollow(after, to, r.positionMsAt);
      expect(rejections(r.ctx)).toBe(0);
    });
  }

  test("pattern off returns the gain to 1 and stops writing; on again starts clean", () => {
    const r = rig(STROBE_A);
    vt.advance(10_000);
    r.setPattern(null);
    const offAt = r.ctx.currentTime;
    const last = r.patternGain().gain.events.at(-1)!;
    expect(last).toMatchObject({ kind: "setTarget", value: 1 });
    expect(liveCurves(r.patternGain().gain).every((e) => e.time + e.duration! <= offAt)).toBe(true);
    vt.advance(5000);
    expect(vt.pendingIntervals).toBe(1); // the drift check; the pattern timer is gone
    expect(r.patternGain().gain.events.at(-1)).toBe(last);

    r.setPattern(STROBE_B);
    vt.advance(2000);
    const again = liveCurves(r.patternGain().gain).filter((e) => e.time >= offAt);
    expectCurvesFollow(again, STROBE_B, r.positionMsAt);
    expect(rejections(r.ctx)).toBe(0);
  });
});

describe("ENGINE-SYNC-06 · late ticks and scheduled starts", () => {
  test("after a frozen tab the next curve starts at 'now', aligned to the music, with no overlap", () => {
    const r = rig(STROBE_A);
    vt.advance(5000);
    vt.freeze(3000); // no timer ran for 3 s; the audio kept playing
    const thawedAt = r.ctx.currentTime;
    vt.advance(1000);
    const after = liveCurves(r.patternGain().gain).filter((e) => e.time >= thawedAt - 1e-9);
    expect(after[0]!.time).toBeCloseTo(thawedAt, 9);
    expectCurvesFollow(after, STROBE_A, r.positionMsAt);
    expect(rejections(r.ctx)).toBe(0);
  });

  test("a start still ahead: the first curve begins at the start instant, at track position 0", () => {
    const r = rig(STROBE_B); // scheduled 600 ms ahead
    const first = liveCurves(r.patternGain().gain)[0]!;
    expect(first.time).toBeCloseTo(CTX0 + 0.6, 9);
    expect(first.curve![0]!).toBeCloseTo(evaluatePattern(STROBE_B, 0), 6);
    vt.advance(550); // still before the start: no pile-up of windows while waiting
    expect(liveCurves(r.patternGain().gain)).toHaveLength(1);
  });
});
