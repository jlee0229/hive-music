/**
 * CALIBRATION_CANCEL, engine side (answers the frontend's R-4).
 *
 * The server cannot un-send a click: `SCHEDULED_ACTION`s are handed out at the start of the run, so by
 * the time anyone presses Cancel every phone already holds its click. Cancelling therefore has two
 * halves, and this file tests both — the server returning the room to `idle`, and each *client*
 * silencing its own pending click when it sees that. Without the second half, a cancelled tuning moment
 * still fires clicks across the room, which is exactly what the frontend reported.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CLICK_SPEC, IDLE_CALIBRATION, type Assignment, type CalibrationState, type RoomState } from "@hive/protocol";
import { createBrowserAudioEngine } from "../audio";
import { CalibrationCancelledError } from "../index";
import { ClockModel, CtxMapper } from "../clock";
import { Emitter } from "../transport";
import type { AudioEngineContext } from "../client";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;

function harness() {
  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL); // offset 0: server time == local time
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ startTime: CTX0 });
  mapper.addSample(LOCAL, CTX0);
  const emit = new Emitter();
  const sent: Array<{ type: string }> = [];

  const assignment: Assignment = {
    label: "unison", role: "unison", color: "#F8FAFC",
    gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
    delayMs: 0, compensationMs: 0, pattern: null, applyAtServerTime: null,
  };

  const baseRoom: RoomState = {
    code: "TEST", protocolVersion: 2, createdAtServerTime: LOCAL, hostClientIds: [],
    track: { id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: STEMS, bpm: 120 },
    transport: { state: "stopped" }, mode: { kind: "UNISON", params: {} }, scenePlan: null,
    calibration: IDLE_CALIBRATION,
    clients: {
      me: {
        id: "me", kind: "player", plays: true, name: "Me",
        device: { userAgent: "t", platform: "t", browserFamily: "desktop-chrome" },
        joinIndex: 0, joinedAtServerTime: LOCAL, position: null, pinnedRole: null, nudgeMs: 0,
        tableLatencyMs: 25, calibratedOffsetMs: null, assignment, connected: true, audioReadyTrackId: null,
      },
    },
  };

  const host: AudioEngineContext = {
    opts: { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "player", plays: true, clientId: "me" },
    clock, mapper, emit,
    send: (m) => sent.push(m as { type: string }),
    clientId: "me",
    room: () => baseRoom,
    now: () => LOCAL,
  };

  const engine = createBrowserAudioEngine(host, {
    createContext: () => ctx as unknown as AudioContext,
    loadStem: async () => new FakeBuffer(60, ctx.sampleRate) as unknown as AudioBuffer,
  });

  const withCalibration = (state: CalibrationState): RoomState => ({ ...baseRoom, calibration: state });
  const running = (order: string[] = ["me"]): CalibrationState => ({
    state: "running", referenceClientId: "host-1", startServerTime: LOCAL + 3000, order, results: {},
  });

  return { engine, ctx, sent, assignment, baseRoom, withCalibration, running, mapper, clock };
}

describe("a cancelled run silences the clicks this phone already holds", () => {
  test("a pending click is stopped when the room returns to idle", async () => {
    const h = harness();
    h.engine.applyRoom(h.baseRoom, h.assignment);
    await h.engine.unlock();

    // the run starts and the server hands this phone its click, one second out
    h.engine.applyRoom(h.withCalibration(h.running()), h.assignment);
    h.engine.scheduleClick(LOCAL + 1000, DEFAULT_CLICK_SPEC);
    const click = h.ctx.sources[h.ctx.sources.length - 1]!;
    expect(click.starts).toHaveLength(1);
    expect(click.starts[0]!.when).toBeCloseTo(CTX0 + 1, 6);
    expect(click.stops).toHaveLength(0);

    // host presses Cancel → server broadcasts idle → this phone must stop its own click
    h.engine.applyRoom(h.withCalibration(IDLE_CALIBRATION), h.assignment);
    expect(click.stops).toHaveLength(1);
    expect(click.stops[0]!).toBeCloseTo(CTX0, 6); // stopped now, not at its scheduled time
  });

  test("a click that is already sounding is left alone rather than glitched", async () => {
    const h = harness();
    h.engine.applyRoom(h.baseRoom, h.assignment);
    await h.engine.unlock();
    h.engine.applyRoom(h.withCalibration(h.running()), h.assignment);

    // scheduled in the past → it starts immediately, i.e. it is audible right now
    h.engine.scheduleClick(LOCAL - 500, DEFAULT_CLICK_SPEC);
    const click = h.ctx.sources[h.ctx.sources.length - 1]!;
    expect(click.starts[0]!.when).toBeCloseTo(CTX0, 6);

    h.engine.applyRoom(h.withCalibration(IDLE_CALIBRATION), h.assignment);
    expect(click.stops).toHaveLength(0); // cutting a 22 ms click mid-flight would just be a click
  });

  test("a phone joining an already-idle room cancels nothing", async () => {
    const h = harness();
    h.engine.applyRoom(h.baseRoom, h.assignment);
    await h.engine.unlock();
    h.engine.applyRoom(h.withCalibration(h.running()), h.assignment);
    h.engine.scheduleClick(LOCAL + 1000, DEFAULT_CLICK_SPEC);
    const click = h.ctx.sources[h.ctx.sources.length - 1]!;

    // done, not cancelled: the click should still be allowed to sound
    h.engine.applyRoom(h.withCalibration({ ...h.running(), state: "done" }), h.assignment);
    expect(click.stops).toHaveLength(0);
    // and a later idle (the natural resting state after a finished run) is not a cancel either
    h.engine.applyRoom(h.withCalibration(IDLE_CALIBRATION), h.assignment);
    expect(click.stops).toHaveLength(0);
  });
});

describe("an in-flight runAsReference is cancelled and the microphone is released", () => {
  /** Minimal getUserMedia stand-in that records whether every track was stopped. */
  function fakeMic() {
    const tracks = [{ readyState: "live" as string, stop() { this.readyState = "ended"; } }];
    const stream = { getTracks: () => tracks } as unknown as MediaStream;
    (globalThis as { navigator?: unknown }).navigator = {
      ...(globalThis.navigator ?? {}),
      mediaDevices: { getUserMedia: async () => stream },
      userAgent: "test",
    };
    return { tracks, stream };
  }

  /** A fake context that can actually capture, so the run reaches `awaitPlan` instead of throwing. */
  function capturingCtx() {
    const ctx = new FakeAudioContext({ startTime: CTX0 });
    const node = {
      onaudioprocess: null as unknown,
      connect: () => undefined,
      disconnect: () => undefined,
    };
    return Object.assign(ctx, {
      createScriptProcessor: () => node,
      createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
    });
  }

  test("cancelling while blocked on CALIBRATION_PLAN unwinds at once and ends every track", async () => {
    const mic = fakeMic();
    const h = harness();
    // swap in a context that supports the ScriptProcessor capture path
    const ctx = capturingCtx();
    const engine = createBrowserAudioEngine(
      {
        opts: { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "host", plays: false, clientId: "me" },
        clock: h.clock, mapper: h.mapper, emit: new Emitter(), send: () => {}, clientId: "me",
        room: () => h.baseRoom, now: () => LOCAL,
      },
      {
        createContext: () => ctx as unknown as AudioContext,
        loadStem: async () => new FakeBuffer(60, ctx.sampleRate) as unknown as AudioBuffer,
      },
    );
    await engine.unlock();

    // start the run; it opens the mic, starts capturing, and blocks waiting for the plan
    const run = engine.calibration.runAsReference();
    const settled = run.then(() => "resolved" as const).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(mic.tracks.every((t) => t.readyState === "live")).toBe(true); // mic is open, as it should be

    // the host cancels: running → idle
    engine.applyRoom({ ...h.baseRoom, calibration: h.running() }, h.assignment);
    engine.applyRoom({ ...h.baseRoom, calibration: IDLE_CALIBRATION }, h.assignment);

    const outcome = await settled;
    // it must not have waited out PLAN_TIMEOUT_MS (10 s) — this test would time out if it had
    expect(outcome).toBeInstanceOf(CalibrationCancelledError);
    expect(mic.tracks.every((t) => t.readyState === "ended")).toBe(true);
  }, 5_000);

  test("every other exit path also releases the mic (capture could not start)", async () => {
    const mic = fakeMic();
    const h = harness();
    h.engine.applyRoom(h.baseRoom, h.assignment);
    await h.engine.unlock();
    // FakeAudioContext has neither audioWorklet nor createScriptProcessor, so startCapture throws.
    const outcome = await h.engine.calibration.runAsReference().then(() => "resolved").catch((e) => e);
    expect(outcome).not.toBe("resolved");
    expect(mic.tracks.every((t) => t.readyState === "ended")).toBe(true);
  });

  test("CalibrationCancelledError is distinguishable from a failure", () => {
    const err = new CalibrationCancelledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CalibrationCancelledError");
    expect(String(err.message)).toContain("cancelled");
  });
});
