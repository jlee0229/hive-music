import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager, type Conn } from "../../rooms";
import { processUpload } from "../process";
import { handleUploadTracks } from "../route";
import { encodeMonoWav16 } from "../wav";

/**
 * SCALE-NET-04 / ENGINE-DSP-04: POST /tracks decoded, resampled, analysed and encoded the song
 * synchronously on the server's one event loop — nobody's NTP probe, ROOM_STATE or PLAY was answered
 * while it ran (scripts/upload-stall.ts: 147 ms of silence for a 3.5-minute song, 270 ms for ten
 * minutes). That work now runs in a Worker; the same script shows 2 ms / 12 ms worst round trips.
 */
const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "hive-upload-worker-"));
  roots.push(d);
  return d;
};
const managers: RoomManager[] = [];
afterAll(() => {
  for (const m of managers) m.shutdown();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** A song with a beat, so the tempo detector does its full work. */
function song(seconds: number): Uint8Array {
  const rate = 44100;
  const s = new Float32Array(seconds * rate);
  let seed = 7;
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    s[i] = (i % (rate / 2) < 400 ? 0.8 : 0) + ((seed >>> 16) / 65536 - 0.5) * 0.05;
  }
  return encodeMonoWav16(s, rate);
}
/** Longest time the event loop went without running a 2 ms timer while `work` was in flight. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
  }, 2);
  try {
    await work();
  } finally {
    clearInterval(tick);
  }
  return Math.max(worst, performance.now() - last);
}

describe("uploads are processed off the event loop", () => {
  test("the same upload stalls the loop far less through POST /tracks than the work itself takes inline, and writes the same files", async () => {
    const bytes = song(180);
    // inline: what the handler used to do on the request path
    const inlineDir = tempDir();
    const inlineStall = await longestStall(() =>
      processUpload({ id: "inline-track", title: "Same Song", trackDir: join(inlineDir, "tracks", "inline-track"), owner: null, stems: [{ name: "mix", bytes: bytes.slice() }], roomInLibrary: Infinity, roomForOwner: null }),
    );

    // through the route (a Worker does the work)
    const fixtures = tempDir();
    const manager = new RoomManager({ fixturesDir: fixtures, libraryScope: "global" });
    managers.push(manager);
    manager.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
    await manager.loadLibrary();
    const room = manager.createRoom();
    if ("error" in room) throw new Error(room.error);
    const form = new FormData();
    form.set("title", "Same Song");
    form.set("mix", new File([bytes as unknown as BlobPart], "mix.wav"));
    let response: Response | undefined;
    const routeStall = await longestStall(async () => {
      response = await handleUploadTracks(new Request("http://hive.test/tracks", { method: "POST", body: form, headers: { authorization: `Bearer ${room.hostKey}` } }), manager, fixtures, "http://hive.test", {});
    });
    expect(response!.status).toBe(201);
    const track = ((await response!.json()) as { track: { id: string; durationSec: number; bpm?: number } }).track;

    // the loop was held for a fraction of what the work costs (3 minutes of audio: ~150 ms inline here)
    expect(inlineStall).toBeGreaterThan(40);
    expect(routeStall).toBeLessThan(inlineStall / 2);

    // and nothing about the result depends on where it ran
    const viaWorker = join(fixtures, "tracks", track.id);
    const inline = join(inlineDir, "tracks", "inline-track");
    expect(Buffer.from(readFileSync(join(viaWorker, "mix.wav"))).equals(readFileSync(join(inline, "mix.wav")))).toBe(true);
    const metaA = JSON.parse(readFileSync(join(viaWorker, "meta.json"), "utf8"));
    const metaB = JSON.parse(readFileSync(join(inline, "meta.json"), "utf8"));
    expect({ ...metaA, id: "x" }).toEqual({ ...metaB, id: "x" });
    expect(track.durationSec).toBe(180);
    expect(typeof metaA.bpm).toBe("number");
  }, 30_000);
});
