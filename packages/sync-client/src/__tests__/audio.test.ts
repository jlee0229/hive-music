/**
 * B3-lite: the parts of the audio engine that are not scheduling — the click waveform, the
 * interruption/resume path, and the rule that a calibration click ignores WAVE's spatial delay.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CLICK_SPEC, type Assignment, type RoomState } from "@hive/protocol";
import { createBrowserAudioEngine } from "../audio";
import { renderClick, clickDurationSec } from "../calibration/click";
import { ClockModel, CtxMapper } from "../clock";
import { Emitter } from "../transport";
import type { AudioEngineContext } from "../client";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

describe("renderClick", () => {
  test("length follows the spec and the sample rate", () => {
    for (const rate of [44100, 48000]) {
      const click = renderClick(DEFAULT_CLICK_SPEC, rate);
      expect(click.length).toBe(Math.round((2 / 1000) * rate) + Math.round((20 / 1000) * rate));
      expect(click.length / rate).toBeCloseTo(clickDurationSec(DEFAULT_CLICK_SPEC), 4);
    }
  });

  test("it is deterministic: the reference correlates against exactly what the player emitted", () => {
    // Different devices build the template independently; if the noise burst differed, the matched
    // filter would find nothing. Same spec + same rate must give the same samples, bit for bit.
    const a = renderClick(DEFAULT_CLICK_SPEC, 48000);
    const b = renderClick(DEFAULT_CLICK_SPEC, 48000);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i]!);
  });

  test("peak-normalised, and the chirp really sweeps upward", () => {
    const rate = 48000;
    const click = renderClick(DEFAULT_CLICK_SPEC, rate);
    let peak = 0;
    for (const v of click) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(1, 6);

    // zero-crossing rate is a cheap proxy for frequency: the end of the chirp must be higher than the start
    const burst = Math.round((DEFAULT_CLICK_SPEC.burstMs / 1000) * rate);
    const chirp = click.subarray(burst);
    const crossings = (from: number, to: number) => {
      let n = 0;
      for (let i = from + 1; i < to; i++) if (Math.sign(chirp[i]!) !== Math.sign(chirp[i - 1]!)) n++;
      return n;
    };
    const half = Math.floor(chirp.length / 2);
    const early = crossings(0, half);
    const late = crossings(half, chirp.length);
    expect(late).toBeGreaterThan(early);
    // 2 → 6 kHz over 20 ms: roughly 3x the crossings in the second half
    expect(late / early).toBeGreaterThan(1.5);
  });
});

// ---- engine harness ---------------------------------------------------------
const STEMS = ["drums", "bass", "vocals", "other"];

function engineHarness(opts: { compensationMs?: number; delayMs?: number } = {}) {
  const clock = new ClockModel();
  const local = 1_700_000_000_000;
  clock.addProbe(local, local, local, local); // offset exactly 0, so server time == local time
  const mapper = new CtxMapper(clock);
  const ctx = new FakeAudioContext({ startTime: 10 });
  mapper.addSample(local, 10);

  const emit = new Emitter();
  const sent: unknown[] = [];
  const events: Array<{ state: string; progress: number }> = [];
  emit.on("audio", (state, progress) => events.push({ state, progress }));

  const assignment: Assignment = {
    label: "unison",
    role: "unison",
    color: "#F8FAFC",
    gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
    delayMs: opts.delayMs ?? 0,
    compensationMs: opts.compensationMs ?? 0,
    pattern: null,
    applyAtServerTime: null,
  };

  const room: RoomState = {
    code: "TEST",
    protocolVersion: 1,
    createdAtServerTime: local,
    hostClientIds: [],
    track: { id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: STEMS, bpm: 120 },
    transport: { state: "stopped" },
    mode: { kind: "UNISON", params: {} },
    scenePlan: null,
    calibration: { state: "idle", referenceClientId: null, startServerTime: null, order: [], results: {} },
    clients: {
      me: {
        id: "me",
        kind: "player",
        plays: true,
        name: "Me",
        device: { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" },
        joinIndex: 0,
        joinedAtServerTime: local,
        position: null,
        pinnedRole: null,
        nudgeMs: 0,
        tableLatencyMs: 25,
        calibratedOffsetMs: null,
        assignment,
        connected: true,
        audioReadyTrackId: null,
      },
    },
  };

  const host: AudioEngineContext = {
    opts: { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "player", plays: true, clientId: "me" },
    clock,
    mapper,
    emit,
    send: (m) => sent.push(m),
    clientId: "me",
    room: () => room,
    now: () => local,
  };

  const engine = createBrowserAudioEngine(host, {
    createContext: () => ctx as unknown as AudioContext,
    loadStem: async () => new FakeBuffer(60, ctx.sampleRate) as unknown as AudioBuffer,
  });
  return { engine, ctx, room, assignment, sent, events, clock, mapper, serverNow: local };
}

describe("audio engine lifecycle", () => {
  test("unlock loads every stem, then sends AUDIO_READY exactly once", async () => {
    const h = engineHarness();
    h.engine.applyRoom(h.room, h.assignment);
    expect(h.engine.state).toBe("locked"); // no context yet: the snapshot is remembered, nothing plays

    await h.engine.unlock();
    expect(h.engine.state).toBe("ready");
    expect(h.engine.loadProgress).toBe(1);
    const ready = h.sent.filter((m) => (m as { type: string }).type === "AUDIO_READY");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toEqual({ type: "AUDIO_READY", trackId: "synthetic-60s" });

    // the state machine went locked → loading → ready, and progress ended at 1
    const states = h.events.map((e) => e.state);
    expect(states).toContain("loading");
    expect(states[states.length - 1]).toBe("ready");

    // a second snapshot must not reload or re-announce
    h.engine.applyRoom(h.room, h.assignment);
    expect(h.sent.filter((m) => (m as { type: string }).type === "AUDIO_READY")).toHaveLength(1);
  });

  test("an interruption goes to locked and keeps the buffers, so resuming returns straight to ready", async () => {
    const h = engineHarness();
    h.engine.applyRoom(h.room, h.assignment);
    await h.engine.unlock();
    expect(h.engine.state).toBe("ready");

    // iOS: a phone call or the lock screen
    h.ctx.state = "suspended";
    h.ctx.onstatechange?.();
    expect(h.engine.state).toBe("locked");
    expect(h.engine.debug.loadedTrackId).toBe("synthetic-60s"); // buffers retained

    // the next tap resumes; no download, no second AUDIO_READY
    await h.engine.unlock();
    expect(h.engine.state).toBe("ready");
    expect(h.sent.filter((m) => (m as { type: string }).type === "AUDIO_READY")).toHaveLength(1);
  });

  test("outputLatency is reported once a context exists, and null before that", async () => {
    const h = engineHarness();
    expect(h.engine.outputLatencyMs).toBeNull();
    await h.engine.unlock();
    expect(h.engine.outputLatencyMs).toBeNull(); // the fake reports 0, which we treat as "unknown"
  });

  test("a calibration click is compensated but ignores WAVE's spatial delay", async () => {
    // docs/04 step 6: the click carries compensationMs and NOT delayMs — a deliberate spatial delay
    // must not move the signal we are using to measure latency.
    const h = engineHarness({ compensationMs: 40, delayMs: 240 });
    h.engine.applyRoom(h.room, h.assignment);
    await h.engine.unlock();
    const before = h.ctx.sources.length;

    const at = h.serverNow + 1000; // one second from now on the shared clock
    h.engine.scheduleClick(at, DEFAULT_CLICK_SPEC);
    expect(h.ctx.sources.length).toBe(before + 1);
    const click = h.ctx.sources[h.ctx.sources.length - 1]!;
    expect(click.starts).toHaveLength(1);
    // ctx 10 is server `local`; +1 s → ctx 11, minus 40 ms of compensation, and no 240 ms of delay
    expect(click.starts[0]!.when).toBeCloseTo(11 - 0.04, 6);
    expect(click.buffer!.duration).toBeCloseTo(clickDurationSec(DEFAULT_CLICK_SPEC), 4);
  });

  test("local mute is master-only and never touches the assignment's gains", async () => {
    const h = engineHarness();
    h.engine.applyRoom(h.room, h.assignment);
    await h.engine.unlock();
    h.engine.setMuted(true);
    expect(h.engine.muted).toBe(true);
    // the master gain is the first gain node the scheduler creates
    const master = h.ctx.gains[0]!;
    expect(master.gain.events.some((e) => e.kind === "setTarget" && e.value === 0)).toBe(true);
    h.engine.setMuted(false);
    expect(master.gain.events.some((e) => e.kind === "setTarget" && e.value === 1)).toBe(true);
  });

  test("dispose tears the context down", async () => {
    const h = engineHarness();
    await h.engine.unlock();
    h.engine.dispose();
    expect(h.ctx.state).toBe("closed");
    expect(h.engine.state).toBe("locked");
  });
});
