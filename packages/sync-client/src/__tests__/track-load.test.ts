/**
 * ENGINE-SYNC-02 · getting a track onto the phone, when the network and the host do not cooperate.
 *
 * The server publishes ROOM_STATE on change, not on a clock — in a settled room the next snapshot can be
 * a whole song away. Anything the engine leaves "for the next snapshot" is therefore left, possibly, for
 * minutes. Two things were: the retry after a failed download, and noticing that the room had moved to
 * another track while a download was in flight.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deferred, engineRig, LOCAL0, STEMS, type Deferred } from "./engine-rig";
import { FakeBuffer } from "./fake-audio";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const trackOf = (url: string): string => url.split("/audio/")[1]!.split("/")[0]!;

describe("ENGINE-SYNC-02 · a failed download is retried by the engine itself", () => {
  test("flaky Wi-Fi at a track change: the phone recovers with no further snapshot", async () => {
    let failing = true;
    const r = engineRig(vt, {
      loadStem: async () => {
        if (failing) throw new Error("network down");
        return new FakeBuffer(60);
      },
    });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(LOCAL0 + 5000) });
    await flushMicrotasks();
    expect(r.engine.state).toBe("unlocked");
    expect(r.errors.map((e) => e.code)).toEqual(["AUDIO_LOAD_FAILED"]);

    // still down for a while: retries happen, but on the doubling backoff (1 s, 2 s, 4 s) — not a storm
    await vt.advanceAsync(6500);
    const attemptsWhileDown = r.loadCalls.length / STEMS.length;
    expect(attemptsWhileDown).toBeGreaterThanOrEqual(3);
    expect(attemptsWhileDown).toBeLessThanOrEqual(4);

    // the network comes back; not one ROOM_STATE has arrived since the first
    failing = false;
    await vt.advanceAsync(9000);
    expect(r.engine.state).toBe("ready");
    expect(r.engine.debug.playing).toBe(true);
    // and it drops in mid-song at the position the timeline says, not at the top
    const expected = (r.localMs() - (LOCAL0 + 5000)) / 1000;
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    for (const s of live) expect(s.positionAt(r.ctx.currentTime)).toBeCloseTo(expected, 6);

    // success ends the retrying
    const calls = r.loadCalls.length;
    await vt.advanceAsync(120_000);
    expect(r.loadCalls.length).toBe(calls);
  });

  test("a disposed engine does not keep retrying", async () => {
    const r = engineRig(vt, {
      loadStem: async () => {
        throw new Error("404");
      },
    });
    await r.engine.unlock();
    r.apply({ trackId: "song-a" });
    await flushMicrotasks();
    expect(r.engine.state).toBe("unlocked");
    r.engine.dispose();
    const calls = r.loadCalls.length;
    await vt.advanceAsync(60_000);
    expect(r.loadCalls.length).toBe(calls);
  });
});

describe("ENGINE-SYNC-02 · a second track change while the first is still downloading", () => {
  function gatedRig() {
    const gates = new Map<string, Deferred<unknown>>();
    const r = engineRig(vt, {
      loadStem: (url) => {
        const d = deferred<unknown>();
        gates.set(url, d);
        return d.promise;
      },
    });
    const settle = (trackId: string, how: "ok" | "fail"): void => {
      for (const [url, d] of gates) {
        if (trackOf(url) !== trackId) continue;
        if (how === "ok") d.resolve(new FakeBuffer(60));
        else d.reject(new Error("aborted"));
      }
    };
    return { r, settle };
  }

  test("the newer track starts loading at once and the stale one never becomes 'ready'", async () => {
    const { r, settle } = gatedRig();
    await r.engine.unlock();
    r.apply({ trackId: "song-a", transport: r.playingAt(LOCAL0 + 5000) });
    await flushMicrotasks();
    r.apply({ trackId: "song-b", transport: r.playingAt(LOCAL0 + 6000) });
    await flushMicrotasks();
    expect(r.loadCalls.map(trackOf)).toEqual([...STEMS.map(() => "song-a"), ...STEMS.map(() => "song-b")]);

    settle("song-a", "ok"); // the stale download finishes first
    await flushMicrotasks();
    expect(r.engine.debug.loadedTrackId).toBeNull();
    expect(r.engine.state).toBe("loading");
    expect(r.sent.filter((m) => m.type === "AUDIO_READY")).toHaveLength(0);

    vt.advance(9000); // song-b's download outlasts the lead: the room is 3 s into it
    settle("song-b", "ok");
    await flushMicrotasks();
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
    expect(r.engine.state).toBe("ready");
    expect(r.sent.filter((m) => m.type === "AUDIO_READY").map((m) => m.trackId)).toEqual(["song-b"]);
    const live = r.ctx.liveSources(r.ctx.currentTime + 0.05);
    expect(live).toHaveLength(STEMS.length);
    for (const s of live) expect(s.positionAt(r.ctx.currentTime)).toBeCloseTo(3, 6);
  });

  test("a stale download that fails does not knock the live one back to 'unlocked'", async () => {
    const { r, settle } = gatedRig();
    await r.engine.unlock();
    r.apply({ trackId: "song-a" });
    await flushMicrotasks();
    r.apply({ trackId: "song-b" });
    await flushMicrotasks();
    settle("song-a", "fail");
    await flushMicrotasks();
    expect(r.engine.state).toBe("loading");
    expect(r.errors).toHaveLength(0);
    settle("song-b", "ok");
    await flushMicrotasks();
    expect(r.engine.state).toBe("ready");
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
  });
});

describe("ENGINE-SYNC-23 · a re-announce held back by the rate guard is not forgotten", () => {
  test("a server that restarts 300 ms after the announcement still learns the phone is ready, with no further snapshot", async () => {
    const r = engineRig(vt);
    await r.engine.unlock();
    r.apply({ audioReadyTrackId: null });
    await flushMicrotasks();
    const readies = () => r.sent.filter((m) => m.type === "AUDIO_READY").length;
    expect(readies()).toBe(1);

    // The room comes back on a fresh server 300 ms later (the first step of the reconnect backoff):
    // its snapshot says it has never heard of this phone being ready.
    vt.advance(300);
    r.apply({ audioReadyTrackId: null });
    expect(readies()).toBe(1); // inside the guard: our first message could still be in flight

    vt.advance(250); // the guard expires; nothing else arrives — a settled room publishes nothing
    expect(readies()).toBe(2);

    vt.advance(30_000); // and it is not a loop
    expect(readies()).toBe(2);
    r.apply({ audioReadyTrackId: "song-a" }); // the server caught up
    vt.advance(5000);
    expect(readies()).toBe(2);
    r.engine.dispose();
    expect(vt.pending).toBe(0);
  });
});
