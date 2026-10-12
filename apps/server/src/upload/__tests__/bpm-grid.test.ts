/**
 * Beat-grid regressions, on the synthetic tracks of scripts/bpm-eval.ts (seeded, known tempo and
 * known first beat). The full scorecard is `bun apps/server/scripts/bpm-eval.ts`; these are the
 * cases that were wrong in production, pinned.
 */
import { describe, expect, test } from "bun:test";
import { evaluatePattern, IDLE_CALIBRATION, plan, PROTOCOL_VERSION, type RoomState } from "@hive/protocol";
import { classifyTempo, gridErrorSec, renderTrack, type Style, type TrackSpec } from "../../../scripts/bpm-eval";
import { detectBeatGrid } from "../bpm";

const spec = (style: Style, bpm: number, firstBeatSec: number, over: Partial<TrackSpec> = {}): TrackSpec => ({
  id: `${style}-${bpm}`, style, bpm, firstBeatSec, durationSec: 40, sampleRate: 44100, snrDb: 30, intro: "none", jitterMs: 0, breakdown: false, seed: 4242, ...over,
});

describe("ENGINE-DSP-01: syncopated songs are not detected at 4/3 or 2/3 of their tempo", () => {
  // v3 on these: 4/3× (dotted16, dotted_run, slow_16hats, funk_break, dembow, skank_pop) or 2/3×
  // (tresillo, trap_halftime) — the "Baby" / "Party in the U.S.A." / "I Knew You Were Trouble" bug.
  const cases: TrackSpec[] = [
    spec("dotted16", 96.76, 0.241),
    spec("dotted16", 77, 1.1, { intro: "silence" }),
    spec("dotted_run", 94.48, 0.354),
    spec("slow_16hats", 86.09, 0.101, { snrDb: 12, jitterMs: 3 }),
    spec("funk_break", 94.91, 0.256),
    spec("dembow", 91.47, 0.092, { jitterMs: 3 }),
    spec("skank_pop", 80.6, 0.4),
    spec("tresillo", 130.99, 0.862, { intro: "silence", snrDb: 20, jitterMs: 3 }),
    spec("trap_halftime", 153.84, 0.047, { jitterMs: 8 }),
  ];
  for (const s of cases) {
    test(`${s.style} at ${s.bpm} BPM`, () => {
      const grid = detectBeatGrid(renderTrack(s), s.sampleRate);
      expect(grid).not.toBeNull();
      const { verdict, ratio } = classifyTempo(grid!.bpm, s.bpm);
      // the true tempo, its double or its half: every strobe switch lands on a beat or half-beat
      expect(`${verdict} x${ratio}`).toMatch(/^(exact|octave) /);
      // …and the grid sits on the beats, not between them
      expect(Math.abs(gridErrorSec(grid!, s, 0)) * 1000).toBeLessThan(30);
    });
  }
});

describe("ENGINE-DSP-02: the grid is still on the beat four minutes in", () => {
  // v3 quantised the period to one envelope frame (~3 BPM at 120, parabola-refined to ~0.3) and
  // rounded bpm to 0.1: a 0.1 BPM error at 120 walks the grid 200 ms off the beat in 240 s.
  const cases: TrackSpec[] = [
    spec("backbeat", 123.45, 0.731, { durationSec: 60 }),
    spec("four_floor", 128, 0.2, { durationSec: 60, jitterMs: 3 }),
    spec("shuffle_12_8", 87.3, 0.5, { durationSec: 60 }),
  ];
  for (const s of cases) {
    test(`${s.style} at ${s.bpm} BPM: tempo to 0.02 BPM, offset to 10 ms, under 30 ms of slide at 240 s`, () => {
      const grid = detectBeatGrid(renderTrack(s), s.sampleRate)!;
      const octave = Math.round(Math.log2(grid.bpm / s.bpm));
      expect(Math.abs(grid.bpm / 2 ** octave - s.bpm)).toBeLessThan(0.02);
      expect(Math.abs(gridErrorSec(grid, s, 0)) * 1000).toBeLessThan(10);
      expect(Math.abs(gridErrorSec(grid, s, 240)) * 1000).toBeLessThan(30);
    });
  }

  test("the offset has the right sign: a later first beat is a larger offset", () => {
    const early = spec("four_floor", 120, 0.1);
    const late = spec("four_floor", 120, 0.3);
    const a = detectBeatGrid(renderTrack(early), 44100)!;
    const b = detectBeatGrid(renderTrack(late), 44100)!;
    expect(Math.abs(a.beatOffsetSec - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(b.beatOffsetSec - 0.3)).toBeLessThan(0.01);
  });

  test("a near-integer fold period is not mistaken for rhythm (the uneven-bin artifact)", () => {
    // Quiet drums under pads: with summed (not averaged) fold bins, the period one hair under 33
    // coarse frames (156.6 BPM) out-scored the real tempo on every weakly rhythmic track.
    for (const s of [spec("ballad", 69.58, 0.325, { intro: "pad", snrDb: 12, jitterMs: 3, breakdown: true, durationSec: 45 }), spec("arp_no_drums", 98.96, 0.25, { intro: "pad", durationSec: 45 })]) {
      const grid = detectBeatGrid(renderTrack(s), s.sampleRate)!;
      expect(classifyTempo(grid.bpm, s.bpm).verdict).toMatch(/exact|octave/);
    }
  });
});

describe("ENGINE-DSP-03: the planner keeps the strobe on the detected grid", () => {
  const strobeRoom = (bpm: number, groups: number, beatsPerSwitch: number): RoomState => ({
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: 0, hostClientIds: [],
    track: { id: "t", title: "t", durationSec: 240, stems: ["mix"], bpm, beatOffsetSec: 0 },
    transport: { state: "stopped" }, mode: { kind: "STROBE", params: { groups, beatsPerSwitch } }, scenePlan: null,
    calibration: IDLE_CALIBRATION,
    clients: {
      "c0-00000000": {
        id: "c0-00000000", kind: "player", plays: true, name: "P0", device: { userAgent: "ua", platform: "x", browserFamily: "other" },
        joinIndex: 0, joinedAtServerTime: 0, position: null, pinnedRole: null, nudgeMs: 0, tableLatencyMs: null, calibratedOffsetMs: null,
        assignment: null, connected: true, audioReadyTrackId: null,
      },
    },
  });
  /** Where group 0 actually switches on nearest to `atMs`, by scanning the pattern itself. */
  const switchOnNear = (room: RoomState, atMs: number): number => {
    const pattern = plan(room)["c0-00000000"]!.pattern!;
    let best = Infinity;
    for (let t = atMs - 2000; t < atMs + 2000; t += 0.25) {
      if (evaluatePattern(pattern, t - 0.25) === 0 && evaluatePattern(pattern, t) > 0 && Math.abs(t - atMs) < Math.abs(best - atMs)) best = t;
    }
    return best;
  };

  // PROPOSED (packages/protocol/src/planner.ts, not this agent's file): the planner rounds the
  // strobe period to whole milliseconds. 128 BPM, 2 groups, quarter notes is 937.5 ms → 938: the
  // switch is 123 ms late by 3:50, and at sixteenths (234.375 → 234) it is 370 ms early — more
  // than a whole step. The detector is now good to ~0.002 BPM; this rounding throws that away.
  for (const [groups, beatsPerSwitch] of [[2, 1], [2, 0.25], [3, 1]] as const) {
    test.failing(`128 BPM, ${groups} groups, ${beatsPerSwitch} beat(s) per switch: the switch at ~3:50 is within 5 ms of a beat`, () => {
      const beatMs = 60000 / 128;
      const rotationMs = beatMs * beatsPerSwitch * groups;
      const k = Math.round(230000 / rotationMs);
      const expected = k * rotationMs; // beatOffsetSec is 0: group 0 switches on at whole rotations
      expect(Math.abs(switchOnNear(strobeRoom(128, groups, beatsPerSwitch), expected) - expected)).toBeLessThan(5);
    });
  }
});
