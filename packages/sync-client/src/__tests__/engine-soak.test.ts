/**
 * A whole-engine soak on simulated time: three hours of a party in well under a second.
 *
 * One phone, an audio clock 80 ppm fast, a STROBE pattern, a single 3-minute song that the server loops
 * (the snapshot arrives LEAD_MS before each end), a clock probe every second, and an iOS-style
 * interruption every twenty minutes. Nothing here is a new scenario; the point is that nothing
 * accumulates — timers, nodes, error — over a length of time no other test covers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEAD_MS, type Pattern } from "@hive/protocol";
import { engineRig, LOCAL0, makeAssignment, STEMS, SimCtx } from "./engine-rig";
import { FakeParam } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
  FakeParam.strictCurves = true;
});
afterEach(() => {
  vt.uninstall();
  FakeParam.strictCurves = false;
});

const SONG_SEC = 180;
const HOURS = 3;
const STROBE: Pattern = { kind: "strobe", periodMs: 500, phaseMs: 0, duty: 0.5, rampMs: 10 };

describe("engine soak", () => {
  test(`${HOURS} simulated hours of looped playback: in sync throughout, and nothing piles up`, async () => {
    const r = engineRig(vt, { durationSec: SONG_SEC });
    const assignment = makeAssignment({ pattern: STROBE, compensationMs: 45 });
    await r.engine.unlock();
    // an audio clock that runs 80 ppm fast: stretch the fake context's time base
    const ctx = r.ctx as SimCtx & { ppm?: number };
    const baseNow = Object.getOwnPropertyDescriptor(SimCtx.prototype, "currentTime")!.get!;
    Object.defineProperty(ctx, "currentTime", { get: () => 10 + (baseNow.call(ctx) - 10) * (1 + 80e-6) });

    let zero = LOCAL0 + LEAD_MS;
    const snapshot = () => r.apply({ transport: r.playingAt(zero), assignment });
    snapshot();
    await flushMicrotasks();

    const totalMs = HOURS * 3600_000;
    let worstErrMs = 0;
    let interruptions = 0;
    let loops = 0;
    let worstIntervals = 0;
    let checks = 0;
    while (vt.nowMs < totalMs) {
      vt.advance(1000);
      // the engine's 1 Hz probe: an exact clock sample plus the (local, ctx) mapping sample
      const t = r.localMs();
      r.clock.addProbe(t, t, t, t);
      const c = r.engine.ctxNow();
      if (c !== null) r.mapper.addSample(t, c);

      // the server loops the song LEAD_MS before it ends
      if (t >= zero + SONG_SEC * 1000 - LEAD_MS) {
        zero += SONG_SEC * 1000;
        loops++;
        snapshot();
      }
      // every 20 minutes: a phone call for 15 s, then a tap
      if (vt.nowMs % 1_200_000 === 0) {
        interruptions++;
        ctx.state = "interrupted";
        ctx.onstatechange?.();
        ctx.freeze();
        vt.advance(15_000);
        expect(r.engine.state).toBe("locked");
        ctx.thaw();
        await r.engine.unlock();
        vt.advance(3000); // one drift tick to land the resync
        continue;
      }
      // what is sounding vs. what the timeline says, away from the joins
      const position = (t - zero + 45) / 1000;
      if (position > 3 && position < SONG_SEC - 3 && vt.nowMs % 7000 === 0) {
        const now = ctx.currentTime;
        const live = ctx.sources.filter((s) => s.liveAt(now));
        expect(live).toHaveLength(STEMS.length);
        for (const s of live) worstErrMs = Math.max(worstErrMs, Math.abs(s.contentPositionAt(now) - position) * 1000);
        checks++;
      }
      worstIntervals = Math.max(worstIntervals, vt.pendingIntervals);
      // keep the fake's own history from growing: only what can still sound matters
      if (vt.nowMs % 600_000 === 0) {
        const now = ctx.currentTime;
        ctx.sources = ctx.sources.filter((s) => s.endsAt > now - 1);
        ctx.gains = [ctx.gains[0]!, ...ctx.gains.slice(-40)];
        for (const g of ctx.gains) g.gain.events = g.gain.events.slice(-50);
      }
    }

    const dbg = r.engine.debug as unknown as {
      resyncCount: number;
      buffersHeld: number;
      slewPpm: number;
      patternCurveRejections: number;
    };
    console.log(
      `[soak] ${HOURS} h · ${loops} loops · ${interruptions} interruptions · ${checks} position checks · worst playhead error ${worstErrMs.toFixed(3)} ms · resyncs ${dbg.resyncCount} · trim ${dbg.slewPpm.toFixed(0)} ppm`,
    );
    expect(loops).toBe(totalMs / (SONG_SEC * 1000));
    expect(checks).toBeGreaterThan(1000);
    // the 80 ppm audio clock is held by the rate trim, inside the deadband plus one tick of drift
    expect(worstErrMs).toBeLessThan(1.5);
    // one resync per interruption at most (the context lost 15 s); never one for drift
    expect(dbg.resyncCount).toBeLessThanOrEqual(interruptions);
    // timers: watchdog + drift + pattern, at every instant of the three hours
    expect(worstIntervals).toBeLessThanOrEqual(3);
    // one context, one set of buffers, no pattern curve ever refused
    expect(r.contexts).toHaveLength(1);
    expect(dbg.buffersHeld).toBe(2 * STEMS.length);
    expect(dbg.patternCurveRejections).toBe(0);
    expect(r.errors).toHaveLength(0);

    r.engine.dispose();
    expect(vt.pending).toBe(0);
  }, 60_000);
});
