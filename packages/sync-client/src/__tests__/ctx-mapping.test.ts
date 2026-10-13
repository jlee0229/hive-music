/**
 * ENGINE-SYNC-16 · the local↔ctx mapping across a suspension.
 *
 * `CtxMapper` is a median over the last ten (local, ctx) samples. A suspension stops ctx time while local
 * time carries on, so every sample from before it — and every sample taken *during* it — describes a
 * relation that is gone. `clock.ctxTimeFor()` and the calibration reference's `serverTimeForCtx()` kept
 * answering with it for seconds afterwards.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig } from "./engine-rig";
import { VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

/** What client.ts does beside every probe: sample (local, ctx) in the same tick. */
function probeTick(r: ReturnType<typeof engineRig>): void {
  const c = r.engine.ctxNow();
  if (c !== null) r.mapper.addSample(r.localMs(), c);
}

describe("ENGINE-SYNC-16 · the ctx mapping across a rebuilt context", () => {
  test("samples from the context that was torn down are not mixed with the new one's", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    for (let i = 0; i < 12; i++) {
      vt.advance(1000);
      probeTick(r);
    }
    r.ctx.freeze(); // a zombie: 'running', clock stopped
    vt.advance(6000);
    expect(r.engine.state).toBe("locked");
    await r.engine.unlock(); // rebuilds; the new context counts from a different origin
    expect(r.contexts).toHaveLength(2);
    expect(r.mapper.serverTimeForCtx(r.ctx.currentTime)!).toBeCloseTo(r.localMs(), 3);
  });
});

describe("ENGINE-SYNC-16 · the ctx mapping across a suspension", () => {
  test("no samples are taken while the context is suspended, and the mapping is right the moment it resumes", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    for (let i = 0; i < 12; i++) {
      vt.advance(1000);
      probeTick(r);
    }
    // sanity: server time == local time in this rig, so the mapping must return "now"
    expect(r.mapper.serverTimeForCtx(r.ctx.currentTime)!).toBeCloseTo(r.localMs(), 3);

    // a phone call: 20 s suspended; probes keep going over the socket
    r.ctx.state = "suspended";
    r.ctx.onstatechange?.();
    r.ctx.freeze();
    expect(r.engine.ctxNow()).toBeNull();
    for (let i = 0; i < 20; i++) {
      vt.advance(1000);
      probeTick(r);
    }
    r.ctx.thaw();
    await r.engine.unlock(); // the tap

    // immediately, before a single new probe: the reference would stamp its recording with this
    expect(r.mapper.serverTimeForCtx(r.ctx.currentTime)!).toBeCloseTo(r.localMs(), 3);
    expect(r.mapper.ctxTimeFor(r.localMs() + 1000)).toBeCloseTo(r.ctx.currentTime + 1, 6);
    vt.advance(1000);
    probeTick(r);
    expect(r.mapper.serverTimeForCtx(r.ctx.currentTime)!).toBeCloseTo(r.localMs(), 3);
  });
});

describe("ENGINE-SYNC-16 · the calibration reference stamps its recording from one same-tick reading", () => {
  test("serverTimeOfCtx agrees with a fresh sampled mapping, and is right where a stale one is not", async () => {
    const { serverTimeOfCtx } = await import("../calibration/reference");
    const r = engineRig(vt);
    await r.engine.unlock();
    for (let i = 0; i < 12; i++) {
      vt.advance(1000);
      probeTick(r);
    }
    const firstFrame = r.ctx.currentTime - 3; // a recording that began 3 s ago
    const sameTick = serverTimeOfCtx(firstFrame, r.ctx.currentTime, r.clock.serverNow(r.localMs()));
    expect(sameTick).toBeCloseTo(r.localMs() - 3000, 6);
    expect(r.mapper.serverTimeForCtx(firstFrame)!).toBeCloseTo(sameTick, 3);

    // The microphone prompt interrupts the context for 2 s (iOS switching the audio session), and the
    // run starts before a single fresh probe has gone out: the sampled mapping has nothing to offer.
    r.ctx.state = "interrupted";
    r.ctx.onstatechange?.();
    r.ctx.freeze();
    vt.advance(2000);
    r.ctx.thaw();
    await r.engine.unlock();
    vt.advance(500);
    const began = r.ctx.currentTime - 0.4;
    expect(serverTimeOfCtx(began, r.ctx.currentTime, r.clock.serverNow(r.localMs()))).toBeCloseTo(r.localMs() - 400, 6);
  });
});
