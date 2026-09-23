/**
 * B5e: the five modes through the engine. The invariant the whole design rests on (docs/02 §7.3) is
 * that a mode switch is a *gain change*, never a reload: every phone holds all four stems decoded from
 * SET_TRACK on, so ORCHESTRA is "turn three of them down", not "download a different file".
 *
 * WAVE is the exception that proves the rule: its `delayMs` moves the playhead, so it is the one mode
 * change that has to reschedule.
 */
import { describe, expect, test } from "bun:test";
import {
  plan, RESYNC_THRESHOLD_MS, WAVE_DEFAULT_SPAN_MS, type Assignment, type RoomState, type Transport,
} from "@hive/protocol";
import { ClockModel, CtxMapper } from "../clock";
import { Scheduler, gainFromDb } from "../scheduler";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;

function rig() {
  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL); // offset 0: server time == local time
  const mapper = new CtxMapper(clock);
  mapper.addSample(LOCAL, CTX0);
  const ctx = new FakeAudioContext({ startTime: CTX0 });
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "synthetic-60s");
  return { ctx, scheduler, clock, mapper };
}

const playing = (at = LOCAL + 600): Transport => ({ state: "playing", serverTimeAtTrackZero: at });
const applyOpts = { trackId: "synthetic-60s", useOutputLatency: false };

/** A room with `n` players, so the real planner produces the real assignments. */
function room(n: number, mode: RoomState["mode"]): RoomState {
  const clients: RoomState["clients"] = {};
  for (let i = 0; i < n; i++) {
    clients[`p${i}`] = {
      id: `p${i}`,
      kind: "player",
      plays: true,
      name: `P${i}`,
      device: { userAgent: "t", platform: "t", browserFamily: "desktop-chrome" },
      joinIndex: i,
      joinedAtServerTime: LOCAL,
      position: { x: i / Math.max(1, n - 1), y: 0.5 },
      pinnedRole: null,
      nudgeMs: 0,
      tableLatencyMs: 0,
      calibratedOffsetMs: null,
      assignment: null,
      connected: true,
      audioReadyTrackId: "synthetic-60s",
    };
  }
  return {
    code: "TEST",
    protocolVersion: 1,
    createdAtServerTime: LOCAL,
    hostClientIds: [],
    track: { id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: STEMS, bpm: 120 },
    transport: playing(),
    mode,
    scenePlan: null,
    calibration: { state: "idle", referenceClientId: null, startServerTime: null, order: [], results: {} },
    clients,
  };
}

const assignmentFor = (r: RoomState, id: string): Assignment => plan(r)[id]!;

describe("mode switches are gain changes", () => {
  test("UNISON → ORCHESTRA re-ramps gains and starts no new source", () => {
    const { ctx, scheduler } = rig();
    const unisonRoom = room(4, { kind: "UNISON", params: {} });
    const a0 = assignmentFor(unisonRoom, "p0");
    scheduler.apply(playing(), a0, applyOpts);
    const sourcesAfterStart = ctx.sources.length;

    // UNISON: every stem audible
    for (const stem of STEMS) expect(a0.gainsDb[stem]).toBe(0);

    const orchRoom = room(4, { kind: "ORCHESTRA", params: {} });
    const a1 = assignmentFor(orchRoom, "p0");
    // ORCHESTRA with 4 players and 4 stems: p0 gets exactly one stem
    const audible = STEMS.filter((s) => a1.gainsDb[s] === 0);
    expect(audible).toHaveLength(1);
    expect(a1.label).toBe(audible[0]!);

    const result = scheduler.apply(playing(), a1, applyOpts);
    expect(result.action).toBe("unchanged");
    expect(ctx.sources.length).toBe(sourcesAfterStart); // nothing was rebuilt

    // the three silenced stems ramped to 0, the audible one to unity
    const targets = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget"));
    expect(targets.filter((e) => e.value === 0).length).toBeGreaterThanOrEqual(3);
    expect(targets.some((e) => e.value === 1)).toBe(true);
  });

  test("every one of the five modes is a gain change except WAVE, which shifts the playhead", () => {
    const shifts: Record<string, number> = {};
    for (const kind of ["UNISON", "ORCHESTRA", "STEREO", "WAVE", "STROBE"] as const) {
      const { ctx, scheduler } = rig();
      const r = room(4, { kind: "UNISON", params: {} });
      scheduler.apply(playing(), assignmentFor(r, "p3"), applyOpts);
      const before = ctx.sources.length;

      const target = room(4, { kind, params: {} });
      const a = assignmentFor(target, "p3");
      const result = scheduler.apply(playing(), a, applyOpts);
      shifts[kind] = a.delayMs;

      if (kind === "WAVE") {
        // p3 sits at x = 1, so it gets the full span: far more than the resync threshold.
        expect(a.delayMs).toBe(WAVE_DEFAULT_SPAN_MS);
        expect(a.delayMs).toBeGreaterThan(RESYNC_THRESHOLD_MS);
        expect(result.action).toBe("restarted");
        expect(ctx.sources.length).toBeGreaterThan(before);
      } else {
        expect(a.delayMs).toBe(0);
        expect(result.action).toBe("unchanged");
        expect(ctx.sources.length).toBe(before);
      }
    }
    expect(shifts).toEqual({ UNISON: 0, ORCHESTRA: 0, STEREO: 0, WAVE: WAVE_DEFAULT_SPAN_MS, STROBE: 0 });
  });

  test("WAVE delays each phone by its position along the axis", () => {
    const r = room(5, { kind: "WAVE", params: { axis: "x", spanMs: 240 } });
    const delays = Object.keys(r.clients).map((id) => assignmentFor(r, id).delayMs);
    expect(delays).toEqual([0, 60, 120, 180, 240]); // x = 0, 0.25, 0.5, 0.75, 1
    // ...and the engine turns that into exactly that much later a start
    const starts = delays.map((_, i) => {
      const { scheduler } = rig();
      const res = scheduler.apply(playing(), assignmentFor(r, `p${i}`), applyOpts);
      return res.decision!.whenCtx;
    });
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i]! - starts[0]!) * 1000).toBeCloseTo(delays[i]!, 6);
    }
  });

  test("STROBE gives each group a different phase and no delay (beat-locked: the fixture has a bpm)", () => {
    // 120 BPM, beatsPerSwitch default 1, 2 groups → the rotation is 2 beats = 1000 ms, and the
    // explicit periodMs param is ignored: with a tempo known, the strobe follows the song.
    const r = room(4, { kind: "STROBE", params: { groups: 2, periodMs: 500, duty: 0.5 } });
    const patterns = Object.keys(r.clients).map((id) => assignmentFor(r, id).pattern!);
    expect(patterns.every((p) => p.kind === "strobe" && p.periodMs === 1000 && p.duty === 0.5)).toBe(true);
    expect(new Set(patterns.map((p) => p.phaseMs))).toEqual(new Set([0, 500]));
    expect(Object.keys(r.clients).every((id) => assignmentFor(r, id).delayMs === 0)).toBe(true);
  });

  test("STEREO splits the stems by side without touching timing", () => {
    const r = room(4, { kind: "STEREO", params: {} });
    const left = assignmentFor(r, "p0"); // x = 0
    const right = assignmentFor(r, "p3"); // x = 1
    expect(left.label).toBe("left");
    expect(right.label).toBe("right");
    expect(gainFromDb(left.gainsDb.drums!)).toBe(1);
    expect(gainFromDb(left.gainsDb.vocals!)).toBe(0);
    expect(gainFromDb(right.gainsDb.vocals!)).toBe(1);
    expect(gainFromDb(right.gainsDb.drums!)).toBe(0);
    expect(left.delayMs).toBe(0);
    expect(right.delayMs).toBe(0);
  });

  test("a nudge smaller than the resync threshold ramps; a big one reschedules", () => {
    const { ctx, scheduler } = rig();
    const r = room(2, { kind: "UNISON", params: {} });
    const base = assignmentFor(r, "p0");
    scheduler.apply(playing(), base, applyOpts);
    const before = ctx.sources.length;

    const small = scheduler.apply(playing(), { ...base, compensationMs: 5 }, applyOpts);
    expect(small.action).toBe("unchanged"); // the drift check absorbs it (B4)
    expect(ctx.sources.length).toBe(before);

    const big = scheduler.apply(playing(), { ...base, compensationMs: 40 }, applyOpts);
    expect(big.action).toBe("restarted");
    // and it moved the start 40 ms earlier than the un-nudged schedule
    const { scheduler: fresh } = rig();
    const plain = fresh.apply(playing(), base, applyOpts);
    expect((plain.decision!.whenCtx - big.decision!.whenCtx) * 1000).toBeCloseTo(40, 6);
  });

  test("identical snapshots at 2 Hz do not re-arm pattern automation", () => {
    const { ctx, scheduler } = rig();
    const r = room(4, { kind: "STROBE", params: {} });
    const a = assignmentFor(r, "p0");
    scheduler.apply(playing(), a, applyOpts);
    const curvesAfterStart = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve")).length;
    expect(curvesAfterStart).toBeGreaterThan(0);

    // five more identical snapshots, as ROOM_STATE would deliver
    for (let i = 0; i < 5; i++) scheduler.apply(playing(), { ...a }, applyOpts);
    const after = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve")).length;
    expect(after).toBe(curvesAfterStart);
    scheduler.dispose();
  });

  test("a non-playing host gets no assignment, so the engine schedules nothing", () => {
    const r = room(2, { kind: "ORCHESTRA", params: {} });
    r.clients.host = {
      ...r.clients.p0!,
      id: "host",
      kind: "host",
      plays: false,
      joinIndex: 99,
    };
    expect(plan(r).host).toBeNull();
    const { ctx, scheduler } = rig();
    const result = scheduler.apply(playing(), plan(r).host ?? null, applyOpts);
    /*
     * This assertion used to read "started", with a comment claiming the server alone keeps a controller
     * silent. That was wrong and it was P0-3: a null assignment built a branch with every stem at
     * gainFromDb(undefined ?? 0) and no compensation, so a host that turned its speaker toggle off
     * mid-song blared unison, out of sync with the room. A null assignment is silence.
     */
    expect(result.action).toBe("idle");
    expect(ctx.allStarts()).toHaveLength(0);
    expect(scheduler.playing).toBe(false);
  });
});

describe("applyAtServerTime", () => {
  test("a scene boundary in the future ramps at that instant on every phone", () => {
    const { ctx, scheduler } = rig();
    const r = room(4, { kind: "UNISON", params: {} });
    scheduler.apply(playing(), assignmentFor(r, "p0"), applyOpts);

    const boundary = LOCAL + 2000; // 2 s ahead on the shared clock
    const orch = { ...assignmentFor(room(4, { kind: "ORCHESTRA", params: {} }), "p0"), applyAtServerTime: boundary };
    scheduler.apply(playing(), orch, applyOpts);

    const times = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget").map((e) => e.time));
    // ctx 10 is server LOCAL, so the boundary is ctx 12
    expect(times.some((t) => Math.abs(t - 12) < 1e-6)).toBe(true);
  });

  test("a boundary already in the past ramps now rather than in the past", () => {
    const { ctx, scheduler } = rig();
    const r = room(4, { kind: "UNISON", params: {} });
    scheduler.apply(playing(), assignmentFor(r, "p0"), applyOpts);
    const orch = { ...assignmentFor(room(4, { kind: "ORCHESTRA", params: {} }), "p0"), applyAtServerTime: LOCAL - 5000 };
    scheduler.apply(playing(), orch, applyOpts);
    const times = ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget").map((e) => e.time));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(CTX0);
  });
});
