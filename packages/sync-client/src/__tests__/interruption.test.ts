/**
 * ENGINE-SYNC-17 · a download that finishes while the context is interrupted reported "ready" — the
 * playing screen over a context that cannot sound.
 *
 * And the mute matrix (lead 7), which found nothing wrong but had no test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deferred, engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

describe("ENGINE-SYNC-17 · a download that lands during an interruption", () => {
  test("is not announced to the UI as 'ready' until the context can sound", async () => {
    const gate = deferred<unknown>();
    const r = engineRig(vt, { loadStem: () => gate.promise });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    expect(r.engine.state).toBe("loading");

    r.ctx.state = "interrupted"; // iOS, mid-download
    r.ctx.onstatechange?.();
    gate.resolve(new FakeBuffer(60));
    await flushMicrotasks();
    expect(r.engine.state).toBe("locked"); // "Tap to resume", not the playing screen over silence
    expect(r.engine.debug.loadedTrackId).toBe("song-a");
    expect(r.sent.filter((m) => m.type === "AUDIO_READY")).toHaveLength(1); // the stems *are* decoded

    await r.engine.unlock();
    expect(r.engine.state).toBe("ready");
    expect(r.engine.debug.playing).toBe(true);
  });
});

describe("the mute matrix (lead 7)", () => {
  const lastMasterTarget = (r: ReturnType<typeof engineRig>): number | undefined =>
    r.ctx.gains[0]!.gain.events.filter((e) => e.kind === "setTarget").at(-1)?.value;

  test("mute before unlock is applied to the context that is created later, and announced", async () => {
    const r = engineRig(vt);
    r.engine.setMuted(true);
    expect(r.engine.muted).toBe(true);
    expect(r.audioEvents).toHaveLength(1); // the UI mirrors `muted` off this event
    await r.engine.unlock();
    expect(lastMasterTarget(r)).toBe(0);
  });

  test("mute survives a track change, an interruption and a zombie rebuild; unmute works after each", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600) });
    await flushMicrotasks();
    r.engine.setMuted(true);
    const master = r.ctx.gains[0]!;

    // track change: the master node is the same one, still at 0
    r.apply({ trackId: "song-b", transport: r.playingAt(r.localMs() + 600) });
    await flushMicrotasks();
    vt.advance(1000);
    expect(r.ctx.gains[0]).toBe(master);
    expect(lastMasterTarget(r)).toBe(0);
    expect(r.ctx.liveSources()).toHaveLength(STEMS.length); // playing, silently

    // interruption and resume
    r.ctx.state = "suspended";
    r.ctx.onstatechange?.();
    await r.engine.unlock();
    expect(r.engine.muted).toBe(true);
    expect(lastMasterTarget(r)).toBe(0);

    // zombie rebuild: a brand-new context, born muted
    vt.advance(2000 - (vt.nowMs % 2000)); // land on a watchdog tick
    r.ctx.freeze();
    vt.advance(4000);
    expect(r.engine.state).toBe("locked");
    await r.engine.unlock();
    expect(r.contexts).toHaveLength(2);
    expect(lastMasterTarget(r)).toBe(0);
    expect(r.engine.muted).toBe(true);

    r.engine.setMuted(false);
    expect(lastMasterTarget(r)).toBe(1);
    expect(r.engine.muted).toBe(false);
  });

  test("mute never touches the assignment's gains or the schedule", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 600), assignment: makeAssignment({ gainsDb: { drums: 0, bass: -60, vocals: -6, other: 0 } }) });
    await flushMicrotasks();
    vt.advance(2000);
    const sources = r.ctx.sources.length;
    const stemEvents = r.ctx.gains.slice(1).map((g) => g.gain.events.length);
    r.engine.setMuted(true);
    r.engine.setMuted(false);
    expect(r.ctx.sources.length).toBe(sources);
    expect(r.ctx.gains.slice(1).map((g) => g.gain.events.length)).toEqual(stemEvents);
  });
});
