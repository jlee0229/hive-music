/**
 * Engine P0 regressions. Every test here fails against `main` as of 61902fc, and each one describes a
 * failure that would have happened on stage with green health lights.
 *
 * The common shape is worth naming: all four are cases where the engine was confidently wrong — it did
 * something plausible, reported success, and the drift check could not see the error because the error
 * was in the reference the drift check compares against.
 */
import { describe, expect, test } from "bun:test";
import { FUTURE_START_MARGIN_SEC, LATE_START_MARGIN_SEC, decideStart, Scheduler } from "../scheduler";
import { ClockModel, CtxMapper } from "../clock";
import { RoomTransport } from "../transport";
import type { Assignment, Transport } from "@hive/protocol";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const STEMS = ["drums", "bass", "vocals", "other"];
const LOCAL = 1_700_000_000_000;
const CTX0 = 10;

const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  label: "unison", role: "unison", color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0, compensationMs: 0, pattern: null, applyAtServerTime: null,
  ...over,
});
const playing = (at: number): Transport => ({ state: "playing", serverTimeAtTrackZero: at });
const applyOpts = { trackId: "t", useOutputLatency: false };

function rig(opts: { ctxNow?: number } = {}) {
  const clock = new ClockModel();
  clock.addProbe(LOCAL, LOCAL, LOCAL, LOCAL); // offset 0 → server time == local time
  const mapper = new CtxMapper(clock);
  const ctxNow = opts.ctxNow ?? CTX0;
  const ctx = new FakeAudioContext({ startTime: ctxNow });
  mapper.addSample(LOCAL, ctxNow);
  const scheduler = new Scheduler({ ctx, clock, mapper, now: () => LOCAL });
  scheduler.setBuffers(new Map(STEMS.map((s) => [s, new FakeBuffer(60)] as const)), "t");
  return { ctx, clock, mapper, scheduler };
}

describe("P0-5 · a near-future start is scheduled exactly, never rounded to 'now'", () => {
  test("every lead from 1 ms to 200 ms plays track position 0 at exactly the right ctx time", () => {
    // The bug: a lead inside FUTURE_START_MARGIN_SEC took the "immediate" path, where
    // offsetSec = whenCtx − startCtxForZero is negative and was clamped to 0 — so position 0 played at
    // ctxNow + LATE_START_MARGIN_SEC, up to 30 ms EARLY.
    for (const leadMs of [1, 5, 15, 20, 21, 25, 30, 45, 49, 50, 51, 100, 200]) {
      const startCtxForZero = CTX0 + leadMs / 1000;
      const d = decideStart({ ctxNow: CTX0, startCtxForZero, durationSec: 60 })!;
      const positionZeroPlaysAt = d.whenCtx - d.offsetSec;
      expect(
        (positionZeroPlaysAt - startCtxForZero) * 1000,
        `lead ${leadMs} ms scheduled position 0 in the wrong place`,
      ).toBeCloseTo(0, 9);
      expect(d.offsetSec, `lead ${leadMs} ms produced a negative offset`).toBeGreaterThanOrEqual(0);
    }
  });

  test("a start 30 ms out is source.start(startCtxForZero, 0), and the drift check then reads ~0", () => {
    const r = rig();
    // zero 30 ms in the future on the shared clock
    const zero = LOCAL + 30;
    const a = assignment();
    const result = r.scheduler.apply(playing(zero), a, applyOpts);
    expect(result.decision!.mode).toBe("scheduled");
    expect(result.decision!.whenCtx).toBeCloseTo(CTX0 + 0.03, 9);
    expect(result.decision!.offsetSec).toBe(0);
    for (const s of r.ctx.allStarts()) {
      expect(s.when).toBeCloseTo(CTX0 + 0.03, 9);
      expect(s.offset).toBe(0);
    }
    // and the branch's reference equals what was actually scheduled, so drift is honest
    expect(Math.abs(r.scheduler.driftErrorMs(a, false)!)).toBeLessThan(0.001);
  });

  test("two phones that get the snapshot at different leads agree with each other", () => {
    // Before the fix: the phone with 40 ms of lead started 20 ms early, the phone with 600 ms started on
    // time, and they were 20 ms apart with both reporting zero drift.
    const emitted = (leadMs: number): number => {
      const r = rig();
      const zero = LOCAL + leadMs;
      const d = r.scheduler.apply(playing(zero), assignment(), applyOpts).decision!;
      // ctx time at which position 0 leaves the speaker, mapped back to the shared clock
      const positionZeroAtCtx = d.whenCtx - d.offsetSec;
      return LOCAL + (positionZeroAtCtx - CTX0) * 1000;
    };
    const near = emitted(40);
    const far = emitted(600);
    expect(Math.abs(near - (LOCAL + 40))).toBeLessThan(0.001);
    expect(Math.abs(far - (LOCAL + 600))).toBeLessThan(0.001);
    // both land on their own zero, so relative to the timeline they are identical
    expect(Math.abs((near - (LOCAL + 40)) - (far - (LOCAL + 600)))).toBeLessThan(0.001);
  });

  test("the margins still mean what they say for a genuinely late join", () => {
    // 30 s into a 60 s track: genuinely late, so the immediate path is right.
    const d = decideStart({ ctxNow: 40, startCtxForZero: 10, durationSec: 60 })!;
    expect(d.mode).toBe("immediate");
    expect(d.whenCtx).toBeCloseTo(40 + LATE_START_MARGIN_SEC, 9);
    expect(d.offsetSec).toBeCloseTo(30 + LATE_START_MARGIN_SEC, 9);
    expect(FUTURE_START_MARGIN_SEC).toBe(0.05);
    // and past the end there is still nothing to start
    expect(decideStart({ ctxNow: 100, startCtxForZero: 10, durationSec: 60 })).toBeNull();
  });
});

describe("P0-3 · a null assignment is silence, not every stem at 0 dB", () => {
  test("losing the assignment mid-song stops the audio", () => {
    const r = rig();
    r.scheduler.apply(playing(LOCAL + 600), assignment(), applyOpts);
    expect(r.scheduler.playing).toBe(true);
    const sources = r.ctx.sources.length;

    // the host turns "use this phone as a speaker" off: plan() now returns null for it
    const result = r.scheduler.apply(playing(LOCAL + 600), null, applyOpts);
    expect(result.action).toBe("stopped");
    expect(r.scheduler.playing).toBe(false);
    expect(r.ctx.sources.length).toBe(sources); // silenced, not rebuilt
    expect(r.ctx.sources.every((s) => s.starts.length === 0 || s.stops.length === 1)).toBe(true);
  });

  test("a null assignment never starts anything in the first place", () => {
    const r = rig();
    const result = r.scheduler.apply(playing(LOCAL + 600), null, applyOpts);
    expect(result.action).toBe("idle");
    expect(r.ctx.allStarts()).toHaveLength(0);
    expect(r.scheduler.playing).toBe(false);
  });

  test("when the assignment comes back it schedules from the transport, as a late join", () => {
    const r = rig();
    r.scheduler.apply(playing(LOCAL + 600), assignment(), applyOpts);
    r.scheduler.apply(playing(LOCAL + 600), null, applyOpts);
    expect(r.scheduler.playing).toBe(false);

    // speaker toggled back on, transport unchanged
    const back = r.scheduler.apply(playing(LOCAL + 600), assignment(), applyOpts);
    expect(back.action).toBe("started");
    expect(r.scheduler.playing).toBe(true);
    expect(back.decision).not.toBeNull();
  });

  test("a null assignment runs no pattern automation", () => {
    const r = rig();
    r.scheduler.apply(playing(LOCAL + 600), assignment({ pattern: { kind: "strobe", periodMs: 500, phaseMs: 0, duty: 0.5, rampMs: 10 } }), applyOpts);
    const curvesWhilePlaying = r.ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve")).length;
    expect(curvesWhilePlaying).toBeGreaterThan(0);
    r.scheduler.apply(playing(LOCAL + 600), null, applyOpts);
    const after = r.ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve")).length;
    expect(after).toBe(curvesWhilePlaying); // nothing new written for a phone that is not a speaker
    r.scheduler.dispose();
  });
});

describe("P1-10 · a scene-boundary ramp lands where the audio it gates plays", () => {
  test("the ramp is offset by this phone's compensation, not by the bare clock mapping", () => {
    const r = rig();
    const a = assignment({ compensationMs: 60 });
    r.scheduler.apply(playing(LOCAL + 600), a, applyOpts);

    const boundary = LOCAL + 2000; // 2 s ahead on the shared clock
    r.scheduler.apply(
      playing(LOCAL + 600),
      { ...a, gainsDb: { drums: 0, bass: -60, vocals: -60, other: -60 }, applyAtServerTime: boundary },
      applyOpts,
    );
    const times = r.ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget").map((e) => e.time));
    // ctx 10 is server LOCAL, so the boundary maps to ctx 12 — minus 60 ms of compensation, because that
    // is when the audio for server time `boundary` actually leaves this speaker.
    expect(times.some((t) => Math.abs(t - (12 - 0.06)) < 1e-6)).toBe(true);
    expect(times.some((t) => Math.abs(t - 12) < 1e-6)).toBe(false); // the old, uncompensated instant
  });

  test("WAVE's delay pushes the ramp later by the same amount as the audio", () => {
    const r = rig();
    const a = assignment({ delayMs: 240 });
    r.scheduler.apply(playing(LOCAL + 600), a, applyOpts);
    const boundary = LOCAL + 1000;
    r.scheduler.apply(playing(LOCAL + 600), { ...a, applyAtServerTime: boundary }, applyOpts);
    const times = r.ctx.gains.flatMap((g) => g.gain.events.filter((e) => e.kind === "setTarget").map((e) => e.time));
    expect(times.some((t) => Math.abs(t - (11 + 0.24)) < 1e-6)).toBe(true);
  });
});

describe("P0-4 · one socket per transport", () => {
  /** Counts constructions and records close codes, without a network. */
  function fakeWebSocket() {
    const created: Array<{ url: string; closed: Array<{ code?: number; reason?: string }>; readyState: number; sent: string[] }> = [];
    class FakeWS {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private readonly rec: (typeof created)[number];
      constructor(readonly url: string) {
        this.rec = { url, closed: [], readyState: 0, sent: [] };
        created.push(this.rec);
      }
      send(data: string) {
        this.rec.sent.push(data);
      }
      close(code?: number, reason?: string) {
        this.rec.closed.push({ code, reason });
        this.readyState = 3;
      }
      /** Test helper: complete the handshake and deliver WELCOME. */
      accept() {
        this.readyState = 1;
        this.rec.readyState = 1;
        this.onopen?.();
        this.onmessage?.({
          data: JSON.stringify({ type: "WELCOME", clientId: "me-000001", roomCode: "TEST", serverTime: LOCAL, protocolVersion: 2, isHost: false }),
        });
      }
    }
    const previous = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWS;
    return { created, restore: () => { (globalThis as { WebSocket: unknown }).WebSocket = previous; }, FakeWS };
  }

  test("connect() twice yields one socket and one JOIN", async () => {
    const ws = fakeWebSocket();
    try {
      const t = new RoomTransport(
        { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "player", plays: true, clientId: "me-000001" },
        "me-000001",
        { onWelcome: () => {}, onConnection: () => {} },
        () => LOCAL,
      );
      const first = t.connect();
      // a second call while CONNECTING must join the first, not open another socket
      const second = t.connect();
      expect(ws.created).toHaveLength(1);

      const sock = ws.created[0]!;
      (t as unknown as { ws: { accept(): void } }).ws.accept();
      await Promise.all([first, second]);

      const joins = sock.sent.map((s) => JSON.parse(s) as { type: string }).filter((m) => m.type === "JOIN");
      expect(joins).toHaveLength(1);

      // and once OPEN, a third call is a no-op — this is the "Tap to resume" path after an iOS interrupt
      await t.connect();
      expect(ws.created).toHaveLength(1);
      expect(sock.sent.filter((s) => JSON.parse(s).type === "JOIN")).toHaveLength(1);
    } finally {
      ws.restore();
    }
  });

  test("if a socket is ever replaced, the old one is closed rather than abandoned", async () => {
    const ws = fakeWebSocket();
    try {
      const t = new RoomTransport(
        { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "player", plays: true, clientId: "me-000001" },
        "me-000001",
        { onWelcome: () => {}, onConnection: () => {} },
        () => LOCAL,
      );
      // open() directly, bypassing the connect() guard, to prove the replacement path itself is clean:
      // an abandoned socket's later close is indistinguishable server-side from the live client leaving.
      void (t as unknown as { open(): Promise<void> }).open().catch(() => {});
      void (t as unknown as { open(): Promise<void> }).open().catch(() => {});
      expect(ws.created).toHaveLength(2);
      expect(ws.created[0]!.closed).toHaveLength(1);
      expect(ws.created[0]!.closed[0]!.reason).toBe("replaced");
    } finally {
      ws.restore();
    }
  });
});
