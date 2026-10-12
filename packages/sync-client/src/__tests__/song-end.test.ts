/**
 * ENGINE-SYNC-09 · the end of a song, from the phone's side.
 *
 * The server acts LEAD_MS (600 ms) *before* a song ends: with one song in the library it restarts it with
 * `serverTimeAtTrackZero` set to exactly the old end ("phones schedule the restart on the boundary
 * instant itself"), and with several it switches `room.track` and starts the next one ~5 s later. Either
 * way the snapshot reaches the phone while the last 600 ms of the old song are still to be played — and
 * the engine stopped the old audio the moment the snapshot arrived.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { engineRig, LOCAL0, STEMS } from "./engine-rig";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const DURATION = 10;
const ZERO = LOCAL0 + 600;
const END = ZERO + DURATION * 1000;
/** ctx seconds for a local time, in the rig's first context (ctx 10 ⇔ LOCAL0). */
const ctxAt = (localMs: number): number => 10 + (localMs - LOCAL0) / 1000;

/** A phone 600 ms from the end of a 10 s song. */
async function nearTheEnd() {
  const r = engineRig(vt, { durationSec: DURATION });
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(ZERO) });
  await flushMicrotasks();
  vt.advance(END - 600 - LOCAL0);
  expect(r.ctx.liveSources()).toHaveLength(STEMS.length);
  return r;
}

/** How many sources are sounding at each instant across `[fromMs, toMs)` of local time, in 2 ms steps. */
function liveCounts(r: Awaited<ReturnType<typeof nearTheEnd>>, fromMs: number, toMs: number): Set<number> {
  const seen = new Set<number>();
  for (let t = fromMs; t < toMs; t += 2) seen.add(r.ctx.sources.filter((s) => s.liveAt(ctxAt(t))).length);
  return seen;
}

describe("ENGINE-SYNC-09 · single-song loop", () => {
  test("the restart the server schedules on the boundary is seamless: no silence before it, no overlap after", async () => {
    const r = await nearTheEnd();
    const old = r.ctx.liveSources();
    r.apply({ transport: r.playingAt(END) }); // the loop snapshot, LEAD_MS early
    vt.advance(2000);

    // the old audio runs to the last sample of the song
    for (const s of old) expect(s.endsAt).toBeCloseTo(ctxAt(END), 6);
    // the new pass starts on that same instant, from the top
    const fresh = r.ctx.sources.filter((s) => s.buffer && s.buffer.duration > 1 && !old.includes(s));
    expect(fresh).toHaveLength(STEMS.length);
    for (const s of fresh) expect(s.starts[0]).toEqual({ when: ctxAt(END), offset: 0 });
    // across the join there is always exactly one copy of every stem
    expect([...liveCounts(r, END - 600, END + 1000)]).toEqual([STEMS.length]);
    expect(r.engine.debug.playing).toBe(true);
  });
});

describe("ENGINE-SYNC-09 · playlist advance", () => {
  test("the old song plays out its last 600 ms, then the next one starts on its own start time", async () => {
    const r = await nearTheEnd();
    const old = r.ctx.liveSources();
    const nextZero = END + 5000;
    r.apply({ trackId: "song-b", transport: r.playingAt(nextZero) });
    await flushMicrotasks(); // song-b decodes at once in this rig
    for (const s of old) expect(s.endsAt).toBeCloseTo(ctxAt(END), 6);
    expect([...liveCounts(r, END - 600, END - 2)]).toEqual([STEMS.length]);
    // silence between the songs, not a stuck tail
    expect([...liveCounts(r, END + 20, nextZero - 2)]).toEqual([0]);

    vt.advance(7000);
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(STEMS.length);
    for (const s of live) expect(s.starts[0]).toEqual({ when: ctxAt(nextZero), offset: 0 });
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
  });

  test("a pause during those last moments silences them", async () => {
    const r = await nearTheEnd();
    r.apply({ trackId: "song-b", transport: r.playingAt(END + 5000) });
    await flushMicrotasks();
    vt.advance(100);
    r.apply({ trackId: "song-b", transport: { state: "paused", trackTimeAtPause: 0 } });
    expect(r.ctx.liveSources(r.ctx.currentTime + 0.011)).toHaveLength(0);
  });

  test("a manual SET_TRACK (transport stopped) is still an immediate cut", async () => {
    const r = await nearTheEnd();
    r.apply({ trackId: "song-b", transport: { state: "stopped" } });
    expect(r.ctx.liveSources(r.ctx.currentTime + 0.011)).toHaveLength(0);
  });
});

describe("ENGINE-SYNC-09 · what a hand-over is not", () => {
  test("a track switched mid-song with a long lead does not leave the old song playing for seconds", async () => {
    const r = engineRig(vt, { durationSec: 60 });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(ZERO) });
    await flushMicrotasks();
    vt.advance(20_000);
    r.apply({ trackId: "song-b", transport: r.playingAt(r.localMs() + 5000) });
    expect(r.ctx.liveSources(r.ctx.currentTime + 0.011)).toHaveLength(0);
  });

  test("a seek is a cut: the old position stops now", async () => {
    const r = engineRig(vt, { durationSec: 60 });
    await r.engine.unlock();
    r.apply({ transport: r.playingAt(ZERO) });
    await flushMicrotasks();
    vt.advance(20_000);
    const old = r.ctx.liveSources();
    r.apply({ transport: r.playingAt(r.localMs() + 600 - 40_000) });
    for (const s of old) expect(s.endsAt).toBeCloseTo(r.ctx.currentTime + 0.01, 6);
  });
});
