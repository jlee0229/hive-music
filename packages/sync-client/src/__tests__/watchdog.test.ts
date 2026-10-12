/**
 * ENGINE-SYNC-03 · the silence watchdog and the zombie-context rebuild, on simulated time.
 *
 * The watchdog exists for the "connected but silent" phone: iOS can leave an AudioContext claiming
 * 'running' with a frozen clock. The recovery is to tear the context down inside the next tap and build
 * a new one. These tests are about what that recovery leaves behind, and about everything the engine
 * owns that has to stop when it is told to.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
let restoreDom: (() => void) | null = null;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => {
  vt.uninstall();
  restoreDom?.();
  restoreDom = null;
});

/** A minimal `document` + `navigator.wakeLock`, so the lifecycle code that needs a DOM actually runs. */
function fakeDom() {
  const g = globalThis as unknown as { document?: unknown };
  const hadDocument = "document" in g;
  const previousDocument = g.document;
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (type: string, fn: () => void) => void (type === "visibilitychange" && listeners.add(fn)),
    removeEventListener: (type: string, fn: () => void) => void (type === "visibilitychange" && listeners.delete(fn)),
  };
  g.document = doc;
  const sentinels: Array<{ released: boolean; release(): Promise<void> }> = [];
  const nav = navigator as unknown as Record<string, unknown>;
  const previousWakeLock = Object.getOwnPropertyDescriptor(nav, "wakeLock");
  Object.defineProperty(nav, "wakeLock", {
    configurable: true,
    value: {
      request: async () => {
        const s = {
          released: false,
          release: async () => {
            s.released = true;
          },
        };
        sentinels.push(s);
        return s;
      },
    },
  });
  restoreDom = () => {
    if (hadDocument) g.document = previousDocument;
    else delete g.document;
    if (previousWakeLock) Object.defineProperty(nav, "wakeLock", previousWakeLock);
    else delete nav.wakeLock;
  };
  return {
    doc,
    sentinels,
    listeners,
    fireVisible: () => {
      doc.visibilityState = "visible";
      for (const fn of [...listeners]) fn();
    },
  };
}

async function playingRig(opts: Parameters<typeof engineRig>[1] = {}) {
  const r = engineRig(vt, opts);
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(LOCAL0 + 600) });
  await flushMicrotasks();
  expect(r.engine.debug.playing).toBe(true);
  return r;
}

describe("ENGINE-SYNC-03 · zombie context", () => {
  test("a frozen 'running' context is detected, given one free resume(), then surfaced as locked", async () => {
    const r = await playingRig();
    vt.advance(4000); // freezes just after a watchdog look, so the next two looks both see no progress
    const resumesBefore = r.ctx.resumeCalls;
    r.ctx.freeze();
    vt.advance(2000);
    expect(r.engine.state).toBe("ready"); // one stalled look is not a verdict
    expect(r.ctx.resumeCalls).toBe(resumesBefore + 1);
    vt.advance(2000);
    expect(r.engine.state).toBe("locked");
  });

  test("the rebuild stops the old scheduler: no timers left behind, nothing more built on the dead context", async () => {
    const r = await playingRig();
    vt.advance(5000);
    const timersWhilePlaying = vt.pendingIntervals;
    const dead = r.ctx;
    dead.freeze();
    vt.advance(6000);
    expect(r.engine.state).toBe("locked");

    await r.engine.unlock(); // the Tap to resume
    expect(r.contexts).toHaveLength(2);
    expect(dead.closeCalls).toBe(1);
    expect(r.engine.state).toBe("ready");
    const deadNodes = dead.sources.length + dead.gains.length;

    vt.advance(60_000);
    expect(dead.sources.length + dead.gains.length).toBe(deadNodes);
    expect(vt.pendingIntervals).toBe(timersWhilePlaying);
    // every source on the dead context was told to stop
    for (const s of dead.sources.filter((x) => x.starts.length > 0 && x.buffer && x.buffer.duration > 1)) {
      expect(s.stops.length).toBeGreaterThan(0);
    }
  });

  test("after the rebuild the phone is back on the timeline, with its mute, gains and pitch intact", async () => {
    const dom = fakeDom();
    const originals = new Set<unknown>();
    const r = engineRig(vt, {
      durationSec: 20,
      loadStem: async () => {
        const b = new FakeBuffer(20, 8000);
        originals.add(b);
        return b;
      },
    });
    await r.engine.unlock();
    const choir = makeAssignment({ pitchSemitones: 12, gainsDb: { drums: 0, bass: -60, vocals: -6, other: 0 } });
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: choir });
    await vt.advanceAsync(3000, 10);
    r.engine.setMuted(true);
    expect(r.ctx.liveSources().some((s) => originals.has(s.buffer))).toBe(false);

    r.ctx.freeze();
    vt.advance(6000);
    expect(r.engine.state).toBe("locked");
    await r.engine.unlock();
    await flushMicrotasks();

    const fresh = r.ctx;
    expect(r.contexts).toHaveLength(2);
    const live = fresh.liveSources(fresh.currentTime + 0.05);
    expect(live).toHaveLength(STEMS.length);
    // pitch variant kept: not one of the as-decoded buffers
    expect(live.some((s) => originals.has(s.buffer))).toBe(false);
    // on the timeline
    const expected = (r.localMs() - (LOCAL0 + 600)) / 1000;
    for (const s of live) expect(s.positionAt(fresh.currentTime)).toBeCloseTo(expected, 6);
    // mute survived: the new master gain was driven to 0
    const master = fresh.gains[0]!;
    expect(master.gain.events.filter((e) => e.kind === "setTarget").at(-1)!.value).toBe(0);
    expect(r.engine.muted).toBe(true);
    // assignment gains survived: one stem at -60 dB is built silent
    expect(fresh.gains.some((g) => g.gain.value === 0)).toBe(true);
    // the wake lock is held, exactly once
    expect(dom.sentinels.filter((s) => !s.released)).toHaveLength(1);
  });

  test("a context that starts moving again on its own is not torn down, and the UI is released", async () => {
    const r = await playingRig();
    vt.advance(4000);
    r.ctx.freeze();
    vt.advance(4000);
    expect(r.engine.state).toBe("locked");
    r.ctx.thaw(); // iOS let go without a tap
    vt.advance(4000);
    expect(r.engine.state).toBe("ready");
    await r.engine.unlock(); // any later tap must not rebuild a healthy context
    expect(r.contexts).toHaveLength(1);
    // and the audio is back on the timeline (the freeze cost it 4 s of ctx time)
    const live = r.ctx.liveSources(r.ctx.currentTime + 0.1);
    expect(live).toHaveLength(STEMS.length);
    const expected = (r.localMs() - (LOCAL0 + 600)) / 1000;
    for (const s of live) expect(s.positionAt(r.ctx.currentTime)).toBeCloseTo(expected, 3);
  });

  test("ticks bunched together by a busy main thread are not mistaken for a frozen clock", async () => {
    const r = await playingRig();
    vt.advance(5000);
    vt.burst(4, 20); // four watchdog looks 20 ms apart: the context advanced 20 ms each time, which is healthy
    expect(r.engine.state).toBe("ready");
    vt.advance(10_000);
    expect(r.engine.state).toBe("ready");
    await r.engine.unlock();
    expect(r.contexts).toHaveLength(1);
  });
});

describe("ENGINE-SYNC-03 · the watchdog's self-heal leaves a legitimate silence alone", () => {
  test("a start that is still in the future is not rebuilt", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 5000) }); // a track-advance lead
    await flushMicrotasks();
    const built = r.ctx.sources.length;
    vt.advance(4900);
    expect(r.ctx.sources.length).toBe(built);
    expect(r.ctx.sources.filter((s) => s.buffer && s.buffer.duration > 1).every((s) => s.starts[0]!.when === 15)).toBe(true);
  });

  test("a track that has finished is not restarted, however long the room stays 'playing'", async () => {
    const r = engineRig(vt, { durationSec: 10 });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    const built = r.ctx.sources.length;
    vt.advance(120_000);
    expect(r.ctx.sources.length).toBe(built);
    expect(r.ctx.liveSources()).toHaveLength(0);
    // a phone that joins after the end schedules nothing, now or on any later tick
    const late = engineRig(vt, { durationSec: 10 });
    await late.engine.unlock();
    late.apply({ transport: late.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    vt.advance(30_000);
    expect(late.ctx.sources.filter((s) => s.buffer && s.buffer.duration > 1)).toHaveLength(0);
  });

  test("a missed snapshot is healed: buffers present, room playing, nothing scheduled", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ transport: { state: "stopped" } });
    await flushMicrotasks();
    // The room starts while this phone's context is suspended; the context then comes back without a
    // statechange event (the watchdog's reason to exist).
    r.ctx.state = "suspended";
    r.apply({ transport: r.playingAt(r.localMs() + 600) });
    r.ctx.state = "running";
    vt.advance(4100);
    expect(r.engine.debug.playing).toBe(true);
  });
});

describe("ENGINE-SYNC-03 · dispose() releases everything", () => {
  test("no timer, no DOM listener and no wake lock survive it", async () => {
    const dom = fakeDom();
    const r = await playingRig();
    vt.advance(3000);
    await flushMicrotasks();
    expect(dom.listeners.size).toBe(1);
    expect(dom.sentinels.filter((s) => !s.released)).toHaveLength(1);
    // a second unlock (the user tapped again) must not stack a second lock nobody can release
    await r.engine.unlock();
    await flushMicrotasks();
    expect(dom.sentinels.filter((s) => !s.released)).toHaveLength(1);

    r.engine.dispose();
    await flushMicrotasks();
    expect(vt.pending).toBe(0);
    expect(dom.listeners.size).toBe(0);
    expect(dom.sentinels.filter((s) => !s.released)).toHaveLength(0);

    // the page becomes visible again later: a disposed engine must not take the screen lock back
    dom.fireVisible();
    await flushMicrotasks();
    expect(dom.sentinels.filter((s) => !s.released)).toHaveLength(0);
  });

  test("a download that finishes after dispose() does not bring the engine back", async () => {
    let release!: (b: unknown) => void;
    const gate = new Promise<unknown>((res) => (release = res));
    const r = engineRig(vt, { loadStem: () => gate });
    await r.engine.unlock();
    r.apply({});
    await flushMicrotasks();
    expect(r.engine.state).toBe("loading");
    r.engine.dispose();
    release(new FakeBuffer(60));
    await flushMicrotasks();
    expect(r.engine.state).toBe("locked");
    expect(r.engine.debug.loadedTrackId).toBeNull();
    expect(r.sent.filter((m) => m.type === "AUDIO_READY")).toHaveLength(0);
  });
});
