/**
 * ENGINE-SYNC-21 (wave 2) · the next song is downloaded while the current one plays (SCALE-NET-05).
 *
 * scale-net measured 0 of 50 phones holding the next playlist song at its downbeat on a 10 Mbit/s link:
 * the file takes 15.1 s and the advance announces it 5.6 s ahead. `RoomState.nextTrack` is the server's
 * hint; the engine fetches that track's stem files in the background and keeps the *bytes* (18 MB, not
 * the 39 MB they decode to), then decodes when the song becomes current — ~0.2 s in Chromium on a
 * desktop, 1–2 s on a phone, against a 5.6 s lead.
 *
 * The link here is simulated: a file "arrives" when the test's timer for it fires.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseServerMessage, PROTOCOL_VERSION } from "@hive/protocol";
import type { FetchStemOptions } from "../audio";
import { engineRig, LOCAL0 } from "./engine-rig";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const SONG_SEC = 60;
/** scale-net's numbers: an 18.9 MB file at 10 Mbit/s. */
const DOWNLOAD_MS = 15_100;
const FILE_BYTES = 18_900_000;
const trackOf = (url: string): string => url.split("/audio/")[1]!.split("/")[0]!;

/** A link on which every file takes `ms` to arrive, honouring abort; `failing` rejects instead. */
function slowLink(ms = DOWNLOAD_MS) {
  const state = { failing: false, completed: [] as string[], aborted: [] as string[] };
  const fetchStem = (url: string, o: FetchStemOptions): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        if (state.failing) return reject(new Error("network down"));
        state.completed.push(url);
        o.onProgress?.(1);
        resolve(new ArrayBuffer(8)); // stands in for FILE_BYTES; the rig's decode ignores the contents
      }, ms);
      o.signal?.addEventListener("abort", () => {
        if (settled) return; // a finished download has nothing left to abort
        settled = true;
        clearTimeout(timer);
        state.aborted.push(url);
        reject(new Error("aborted"));
      });
    });
  return { state, fetchStem };
}

/** A phone playing song-a (already loaded), on a link where a song takes 15.1 s to download. */
async function playingRig(opts: { stems?: string[]; decodeMs?: number } = {}) {
  const link = slowLink();
  const r = engineRig(vt, { durationSec: SONG_SEC, fetchStem: link.fetchStem, decodeMs: opts.decodeMs ?? 200 });
  await r.engine.unlock();
  const stems = opts.stems ?? ["mix"];
  // The timeline of song-a. The advance arrives LEAD_MS before `end` and starts the next song 5 s after it.
  const zero = r.localMs() + 600;
  const end = zero + SONG_SEC * 1000;
  const nextZero = end + 5000;
  const snapshot = (over: Parameters<typeof r.apply>[0] = {}) =>
    r.apply({ transport: r.playingAt(zero), stems, nextStems: stems, ...over });
  snapshot();
  await vt.advanceAsync(DOWNLOAD_MS + 500, 100); // this phone's own (first) download of song-a
  expect(r.engine.debug.loadedTrackId).toBe("song-a");
  expect(r.engine.debug.playing).toBe(true);
  link.state.completed.length = 0;
  r.fetchCalls.length = 0;
  return { r, link, snapshot, stems, zero, end, nextZero };
}

describe("ENGINE-SYNC-21 · with the hint, the phone is ready at the downbeat", () => {
  test("10 Mbit/s: without nextTrack the phone drops in ~10 s late; with it, it starts on serverTimeAtTrackZero", async () => {
    // ---- without the hint: today's behaviour, for the record ----
    const cold = await playingRig();
    vt.advance(cold.end - 600 - cold.r.localMs());
    cold.snapshot({ trackId: "song-b", transport: cold.r.playingAt(cold.nextZero) });
    await vt.advanceAsync(cold.nextZero - cold.r.localMs(), 100);
    expect(cold.r.engine.state).toBe("loading"); // the downbeat passes in silence
    await vt.advanceAsync(12_000, 100);
    const late = cold.r.ctx.liveSources()[0]!;
    const lateByMs = Math.round(late.starts[0]!.offset * 1000);
    expect(lateByMs).toBeGreaterThan(9000); // 15.1 s download − 5.6 s lead ≈ 9.5 s of the song missed
    cold.r.engine.dispose();

    // ---- with the hint ----
    const { r, link, snapshot, end, nextZero } = await playingRig();
    snapshot({ nextTrackId: "song-b" });
    await flushMicrotasks();
    expect(r.fetchCalls.map((c) => [trackOf(c.url), c.priority])).toEqual([["song-b", "low"]]);
    expect(r.engine.debug.prefetchTrackId).toBe("song-b");

    vt.advance(end - 600 - r.localMs());
    await flushMicrotasks();
    expect(link.state.completed.map(trackOf)).toEqual(["song-b"]); // it had most of a minute; it needed 15 s
    expect(r.engine.state).toBe("ready"); // and playback of song-a was never interrupted for it
    expect(r.engine.debug.loadedTrackId).toBe("song-a");
    expect(r.decodeCalls).toHaveLength(1); // nothing decoded ahead of time: one song in memory, not two

    const announcedAt = r.localMs();
    snapshot({ trackId: "song-b", transport: r.playingAt(nextZero), nextTrackId: null });
    let readyAt: number | null = null;
    r.emit.on("audio", (state) => {
      if (state === "ready" && r.engine.debug.loadedTrackId === "song-b") readyAt ??= r.localMs();
    });
    await vt.advanceAsync(nextZero - r.localMs() + 200, 20);

    expect(r.fetchCalls).toHaveLength(1); // no second download of the same file
    expect(readyAt).not.toBeNull();
    // decode waited for the old song's last 600 ms to finish, then took 200 ms: ready ~0.8 s after the
    // announcement, ~4.8 s before the downbeat
    expect(readyAt! - announcedAt).toBeLessThan(1500);
    expect(nextZero - readyAt!).toBeGreaterThan(4000);
    console.log(
      `[prefetch] 18.9 MB at 10 Mbit/s (15.1 s) vs a 5.6 s lead: without the hint the phone joins ${lateByMs} ms into the song; ` +
        `with it, ready ${readyAt! - announcedAt} ms after the announcement, ${nextZero - readyAt!} ms before the downbeat`,
    );
    const live = r.ctx.liveSources();
    expect(live).toHaveLength(1);
    expect(live[0]!.starts[0]!.offset).toBe(0); // from the top…
    expect((live[0]!.starts[0]!.when - 10) * 1000).toBeCloseTo(nextZero - LOCAL0, 6); // …exactly on the downbeat
    expect(r.sent.filter((m) => m.type === "AUDIO_READY").map((m) => m.trackId)).toEqual(["song-a", "song-b"]);
  });

  test("decode is held until the previous song has stopped sounding, so two decoded songs never coexist", async () => {
    const { r, snapshot, end, nextZero } = await playingRig();
    snapshot({ nextTrackId: "song-b" });
    vt.advance(end - 600 - r.localMs());
    await flushMicrotasks();
    const decodesBefore = r.decodeCalls.length;
    snapshot({ trackId: "song-b", transport: r.playingAt(nextZero) });
    await vt.advanceAsync(550, 10);
    expect(r.ctx.liveSources()).toHaveLength(1); // song-a's tail is still playing…
    expect(r.decodeCalls.length).toBe(decodesBefore); // …and song-b's decode has not started
    await vt.advanceAsync(200, 10);
    expect(r.ctx.liveSources()).toHaveLength(0);
    expect(r.decodeCalls.length).toBe(decodesBefore + 1);
  });

  test("an advance that arrives mid-download waits for that download instead of starting a second one", async () => {
    const { r, link, snapshot, end, nextZero } = await playingRig();
    vt.advance(end - 600 - 8000 - r.localMs()); // the hint arrives late: 8 s before the announcement
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(8000, 100);
    expect(link.state.completed).toHaveLength(0); // 8 s into a 15.1 s download
    snapshot({ trackId: "song-b", transport: r.playingAt(nextZero) });
    await vt.advanceAsync(9000, 100);
    expect(r.fetchCalls).toHaveLength(1);
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
    // ready 7.1 s + decode after the announcement instead of 15.1 s: 1.7 s into the song, not 9.5 s
    const live = r.ctx.liveSources()[0]!;
    expect(live.starts[0]!.offset).toBeLessThan(2.5);
  });
});

describe("ENGINE-SYNC-21 · when the hint changes, fails or does not apply", () => {
  test("nextTrack changes: the stale download is aborted and the new one starts", async () => {
    const { r, link, snapshot } = await playingRig();
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(5000, 100);
    snapshot({ nextTrackId: "song-c" });
    await flushMicrotasks();
    expect(link.state.aborted.map(trackOf)).toEqual(["song-b"]);
    expect(r.fetchCalls.map((c) => trackOf(c.url))).toEqual(["song-b", "song-c"]);
    expect(r.engine.debug.prefetchTrackId).toBe("song-c");
    await vt.advanceAsync(DOWNLOAD_MS + 100, 100);
    expect(link.state.completed.map(trackOf)).toEqual(["song-c"]);
  });

  test("nextTrack disappears: the download is aborted and what was fetched is let go", async () => {
    const { r, link, snapshot } = await playingRig();
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(DOWNLOAD_MS + 100, 100);
    expect(r.engine.debug.prefetchTrackId).toBe("song-b");
    snapshot({ nextTrackId: null });
    expect(r.engine.debug.prefetchTrackId).toBeNull();
    // and one still in flight is cancelled
    snapshot({ nextTrackId: "song-c" });
    await vt.advanceAsync(1000, 100);
    snapshot({});
    expect(link.state.aborted.map(trackOf)).toEqual(["song-c"]);
  });

  test("the host picks a different song: the pre-download is dropped and the chosen song loads normally", async () => {
    const { r, link, snapshot } = await playingRig();
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(5000, 100);
    snapshot({ trackId: "song-z", transport: { state: "stopped" }, nextTrackId: "song-b" });
    await flushMicrotasks();
    expect(link.state.aborted.map(trackOf)).toEqual(["song-b"]);
    expect(r.fetchCalls.map((c) => [trackOf(c.url), c.priority])).toEqual([["song-b", "low"], ["song-z", undefined]]);
    await vt.advanceAsync(DOWNLOAD_MS + 500, 100);
    expect(r.engine.debug.loadedTrackId).toBe("song-z");
    // song-b is not fetched again while nothing is playing
    expect(r.fetchCalls).toHaveLength(2);
  });

  test("a failed pre-download is silent, is not hammered, and the advance still loads the song the ordinary way", async () => {
    const { r, link, snapshot, end, nextZero } = await playingRig();
    link.state.failing = true;
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(DOWNLOAD_MS + 100, 100);
    expect(r.errors).toHaveLength(0); // nobody needs to hear about it
    expect(r.engine.debug.prefetchTrackId).toBeNull();
    for (let i = 0; i < 10; i++) {
      snapshot({ nextTrackId: "song-b" }); // the server's 5 s heartbeat
      await vt.advanceAsync(1000, 100);
    }
    expect(r.fetchCalls).toHaveLength(1); // inside the 30 s back-off: not retried per snapshot

    link.state.failing = false;
    vt.advance(end - 600 - r.localMs());
    snapshot({ trackId: "song-b", transport: r.playingAt(nextZero) });
    await vt.advanceAsync(DOWNLOAD_MS + 1000, 100);
    expect(r.engine.debug.loadedTrackId).toBe("song-b");
    expect(r.engine.debug.playing).toBe(true);
  });

  test("it does not start while this phone is still downloading the current song, and starts once that is done", async () => {
    const link = slowLink();
    const r = engineRig(vt, { durationSec: SONG_SEC, fetchStem: link.fetchStem });
    await r.engine.unlock();
    // a phone that joins mid-song: the room is 20 s in and already knows what comes next
    const zero = r.localMs() - 20_000;
    const joinedMidSong = () => r.apply({ transport: r.playingAt(zero), stems: ["mix"], nextStems: ["mix"], nextTrackId: "song-b" });
    joinedMidSong();
    await vt.advanceAsync(10_000, 100);
    joinedMidSong();
    expect(r.fetchCalls.map((c) => trackOf(c.url))).toEqual(["song-a"]); // only what it should be playing
    await vt.advanceAsync(5500, 100); // song-a lands; no further snapshot is needed
    expect(r.engine.debug.loadedTrackId).toBe("song-a");
    expect(r.fetchCalls.map((c) => [trackOf(c.url), c.priority])).toEqual([["song-a", undefined], ["song-b", "low"]]);
  });

  test("the single-song loop (no hint, or a hint naming the current song) fetches nothing", async () => {
    const { r, snapshot } = await playingRig();
    snapshot({});
    snapshot({ nextTrackId: null });
    snapshot({ nextTrackId: "song-a" });
    await vt.advanceAsync(5000, 100);
    expect(r.fetchCalls).toHaveLength(0);
  });

  test("a paused room starts nothing, but keeps what it already has", async () => {
    const { r, snapshot } = await playingRig();
    snapshot({ transport: { state: "paused", trackTimeAtPause: 10 }, nextTrackId: "song-b" });
    await vt.advanceAsync(3000, 100);
    expect(r.fetchCalls).toHaveLength(0);
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(DOWNLOAD_MS + 100, 100);
    snapshot({ transport: { state: "paused", trackTimeAtPause: 30 }, nextTrackId: "song-b" });
    expect(r.engine.debug.prefetchTrackId).toBe("song-b");
  });

  test("stems are fetched one at a time, and dispose aborts whatever is in flight", async () => {
    const { r, link, snapshot } = await playingRig({ stems: ["drums", "bass", "vocals", "other"] });
    snapshot({ nextTrackId: "song-b" });
    await vt.advanceAsync(DOWNLOAD_MS + 5000, 100);
    expect(link.state.completed).toHaveLength(1);
    expect(r.fetchCalls).toHaveLength(2); // the second began only when the first had finished
    r.engine.dispose();
    expect(link.state.aborted).toHaveLength(1);
    await vt.advanceAsync(60_000, 1000);
    expect(r.fetchCalls).toHaveLength(2);
    expect(vt.pending).toBe(0);
  });
});

describe("ENGINE-SYNC-21 · the wire", () => {
  test("a ROOM_STATE with nextTrack (present, null or absent) passes the parser every client shares, the stub included", () => {
    const r = engineRig(vt);
    for (const nextTrackId of ["song-b", null, undefined] as const) {
      const { room } = r.makeRoom({ nextTrackId });
      // the short client id the rig uses is fine for the engine but not for the wire schema
      const me = { ...room.clients.me!, id: "me-00000000" };
      const wire = { ...room, protocolVersion: PROTOCOL_VERSION, clients: { [me.id]: me } };
      const parsed = parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room: wire }));
      expect(parsed?.type).toBe("ROOM_STATE");
      const next = (parsed as { room: { nextTrack?: { id: string } | null } }).room.nextTrack;
      expect(next?.id).toBe(nextTrackId ?? undefined);
    }
    void FILE_BYTES;
  });
});
