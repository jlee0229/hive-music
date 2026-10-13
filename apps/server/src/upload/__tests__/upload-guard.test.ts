import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, TrackLibraryResponseSchema, parseServerMessage } from "@hive/protocol";
import { RoomManager, type Conn } from "../../rooms";
import { withUrls } from "../../library";
import { handleUploadTracks, librarySizeBytes, type UploadLimits } from "../route";
import { encodeMonoWav16, parseWav, writeMonoWav16 } from "../wav";
import { normalizeStem } from "../convert";

/**
 * Audit SG-07 (uploads). Before, against HEAD a78b9e8:
 *  - a 44-byte WAV with no audio was accepted as a track with durationSec 0 — SET_TRACK on it (or
 *    the playlist rotation reaching it, in ANY room: the library is global) broadcast a ROOM_STATE
 *    no client could parse;
 *  - a float WAV with NaN/Infinity wrote `"energy": [null, …]` into meta.json;
 *  - a 1.2 KB WAV declaring 1 Hz was resampled into a 53 MB file on the volume (×44 000);
 *  - a 100 MB upload that was always going to be refused for length took 659 MB of RAM first.
 */
type WS = Bun.ServerWebSocket<Conn>;
const roots: string[] = [];
const tempFixtures = () => {
  const d = mkdtempSync(join(tmpdir(), "hive-upload-guard-"));
  roots.push(d);
  return d;
};
const managers: RoomManager[] = [];
afterAll(() => {
  for (const m of managers) for (const code of [...(m as unknown as { rooms: Map<string, unknown> }).rooms.keys()]) m.get(code)?.destroy();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const fixtures = tempFixtures();
  const manager = new RoomManager({ fixturesDir: fixtures });
  managers.push(manager);
  manager.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
  await manager.loadLibrary();
  const room = manager.createRoom();
  if ("error" in room) throw new Error(room.error);
  // the host page's JOIN: it carries the browser's libraryKey, which is what lets the room upload
  const ws = { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
  manager.handleMessage(ws, JSON.stringify({ type: "JOIN", clientId: "host-setup-0001", roomCode: room.code, kind: "host", plays: false, hostKey: room.hostKey, libraryKey: "upload-guard-library-key-0001", device: { userAgent: "t", platform: "t", browserFamily: "other" }, protocolVersion: PROTOCOL_VERSION }));
  return { fixtures, manager, room };
}

function wavBytes(opts: { fmt?: number; ch?: number; rate?: number; bits?: number; frames?: number; claim?: number; fill?: (v: DataView, dataOffset: number) => void }) {
  const fmt = opts.fmt ?? 1;
  const ch = opts.ch ?? 1;
  const rate = opts.rate ?? 44100;
  const bits = opts.bits ?? 16;
  const dataBytes = (opts.frames ?? 0) * ch * (bits / 8);
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const a = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i);
  };
  a(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  a(8, "WAVE");
  a(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, fmt, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * (bits / 8), true);
  v.setUint16(32, ch * (bits / 8), true);
  v.setUint16(34, bits, true);
  a(36, "data");
  v.setUint32(40, opts.claim ?? dataBytes, true);
  opts.fill?.(v, 44);
  return u8;
}
const tone = (seconds: number, rate = 44100) => {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.4;
  return encodeMonoWav16(s, rate);
};

type Ctx = Awaited<ReturnType<typeof setup>>;
async function upload(ctx: Ctx, title: string, files: Record<string, Uint8Array>, limits?: UploadLimits) {
  const form = new FormData();
  form.set("hostKey", ctx.room.hostKey);
  form.set("title", title);
  for (const [field, bytes] of Object.entries(files)) form.set(field, new File([bytes as unknown as BlobPart], `${field}.wav`, { type: "audio/wav" }));
  const res = await handleUploadTracks(new Request("http://hive.test/tracks", { method: "POST", body: form }), ctx.manager, ctx.fixtures, "http://hive.test", {}, limits);
  return { status: res.status, headers: res.headers, body: (await res.json()) as { track?: { id: string; durationSec: number; bpm?: number; energy?: number[]; mine?: boolean }; error?: string; message?: string } };
}
const trackDirs = (ctx: Ctx) => (existsSync(join(ctx.fixtures, "tracks")) ? readdirSync(join(ctx.fixtures, "tracks")).filter((d) => !d.startsWith(".")) : []);

describe("SG-07: an upload cannot put an unusable track into the library", () => {
  test("no audio / under a second of audio is refused and nothing is written", async () => {
    const ctx = await setup();
    expect((await upload(ctx, "empty", { mix: wavBytes({ frames: 0 }) })).status).toBe(400);
    expect((await upload(ctx, "blip", { mix: tone(0.5) })).status).toBe(400);
    expect((await upload(ctx, "blip stems", { drums: tone(0.2), bass: tone(0.9) })).status).toBe(400);
    expect(trackDirs(ctx)).toEqual([]);
    expect((await upload(ctx, "one second", { mix: tone(1) })).status).toBe(201);
  });

  test("the upload response is the library entry, tempo included (parity probe S5)", async () => {
    const ctx = await setup();
    // 20 s of clicks at 120 BPM: long and rhythmic enough for the detector to commit to a tempo
    const rate = 44100;
    const clicks = new Float32Array(rate * 20);
    for (let i = 0; i < clicks.length; i++) clicks[i] = i % (rate / 2) < 300 ? 0.9 * Math.sin(i / 3) : 0;
    const r = await upload(ctx, "Tempo", { mix: encodeMonoWav16(clicks, rate) });
    expect(r.status).toBe(201);
    const inLibrary = ctx.manager.getLibrary().find((t) => t.id === r.body.track!.id)!;
    expect(typeof inLibrary.bpm).toBe("number");
    expect(r.body.track).toMatchObject({ id: inLibrary.id, title: "Tempo", durationSec: inLibrary.durationSec, bpm: inLibrary.bpm, beatOffsetSec: inLibrary.beatOffsetSec });
  });

  test("a float WAV full of NaN and Infinity becomes a track every client can still read", async () => {
    const ctx = await setup();
    const frames = 44100 * 20;
    const poisoned = wavBytes({
      fmt: 3,
      bits: 32,
      frames,
      fill: (v, off) => {
        for (let i = 0; i < frames; i++) v.setFloat32(off + i * 4, i % 7 === 0 ? NaN : i % 11 === 0 ? Infinity : i % 13 === 0 ? -Infinity : i % 22050 < 400 ? 3.5 : 0.01, true);
      },
    });
    const r = await upload(ctx, "poison", { mix: poisoned });
    expect(r.status).toBe(201);
    expect(r.body.track!.energy!.every((e) => Number.isFinite(e) && e >= 0 && e <= 1)).toBe(true);
    if (r.body.track!.bpm !== undefined) expect(Number.isFinite(r.body.track!.bpm)).toBe(true);

    // exactly what GET /tracks would serve, after a JSON round trip
    const listing = JSON.parse(JSON.stringify({ tracks: ctx.manager.getLibrary().map((t) => withUrls(t, "http://hive.test")) }));
    expect(TrackLibraryResponseSchema.safeParse(listing).success).toBe(true);

    // and a room that selects it still broadcasts something phones can parse
    const ws = { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
    ctx.manager.handleMessage(ws, JSON.stringify({ type: "JOIN", clientId: "host-upl-0001", roomCode: ctx.room.code, kind: "host", plays: false, hostKey: ctx.room.hostKey, device: { userAgent: "t", platform: "t", browserFamily: "other" }, protocolVersion: PROTOCOL_VERSION }));
    ctx.manager.handleMessage(ws, JSON.stringify({ type: "SET_TRACK", trackId: r.body.track!.id }));
    const live = ctx.manager.get(ctx.room.code)!;
    expect(live.room.track?.id).toBe(r.body.track!.id);
    expect(parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room: live.room }))).not.toBeNull();
  });

  test("headers written to make the server work are refused with a plain message: absurd sample rates, truncated fmt", async () => {
    const ctx = await setup();
    // 1.2 KB declaring 1 Hz used to become 600 s → a 53 MB file on the volume
    const oneHz = await upload(ctx, "amplify", { mix: wavBytes({ rate: 1, frames: 600 }) });
    expect(oneHz.status).toBe(400);
    expect(oneHz.body.error).toContain("unsupported sample rate");
    expect((await upload(ctx, "zero", { mix: wavBytes({ rate: 0, frames: 1000 }) })).body.error).toContain("unsupported sample rate");
    expect((await upload(ctx, "fast", { mix: wavBytes({ rate: 4_000_000_000, frames: 1000 }) })).status).toBe(400);
    const truncated = await upload(ctx, "cut", { mix: wavBytes({ frames: 0 }).slice(0, 26) });
    expect(truncated.status).toBe(400);
    expect(truncated.body.error).toBe("stem 'mix': WAV file has a truncated fmt chunk");
    expect(trackDirs(ctx)).toEqual([]);
    expect(await librarySizeBytes(ctx.fixtures)).toBe(0);
  });

  test("an over-long stem is refused from its header (parseWav limit), and a normal upload still round-trips", async () => {
    const tooLong = wavBytes({ rate: 8000, bits: 8, frames: 8000 * 601 });
    expect(() => parseWav(tooLong, { maxDurationSec: 600 })).toThrow(/over the 600s limit/);
    expect(() => normalizeStem(tooLong)).toThrow(/over the 600s limit/);
    expect(parseWav(tone(3), { truncateSec: 1 }).channels[0]!.length).toBe(44100); // the backfill's head-only decode
    expect(parseWav(tone(3)).channels[0]!.length).toBe(44100 * 3);

    const ctx = await setup();
    const r = await upload(ctx, "  Fine\u0000 Song\n ", { mix: tone(2) });
    expect(r.status).toBe(201);
    expect(ctx.manager.getLibrary().find((t) => t.id === r.body.track!.id)?.title).toBe("Fine Song"); // control characters never reach the song list
    const dir = join(ctx.fixtures, "tracks", r.body.track!.id);
    expect(readdirSync(dir).sort()).toEqual(["meta.json", "mix.wav"]); // no .tmp left behind
    const onDisk = new Uint8Array(await Bun.file(join(dir, "mix.wav")).arrayBuffer());
    expect(Buffer.from(onDisk).equals(Buffer.from(tone(2)))).toBe(true);
  });
});

describe("SG-07: an upload cannot exhaust memory or disk", () => {
  /** A request whose body must never be touched. */
  const untouchable = (headers: Record<string, string>) =>
    ({
      headers: new Headers(headers),
      formData: () => {
        throw new Error("the body was read");
      },
    }) as unknown as Request;

  test("an over-limit Content-Length is refused before the body is read", async () => {
    const ctx = await setup();
    const res = await handleUploadTracks(untouchable({ "content-length": String(65 * 1024 * 1024) }), ctx.manager, ctx.fixtures, "http://hive.test", {});
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("64 MB");
  });

  test("a wrong Authorization bearer is refused before the body is read; the right one authorises without a form field", async () => {
    const ctx = await setup();
    const res = await handleUploadTracks(untouchable({ "content-length": "1000", authorization: "Bearer not-a-host-key" }), ctx.manager, ctx.fixtures, "http://hive.test", {});
    expect(res.status).toBe(403);

    const form = new FormData();
    form.set("title", "bearer");
    form.set("mix", new File([tone(1) as unknown as BlobPart], "mix.wav"));
    const ok = await handleUploadTracks(new Request("http://hive.test/tracks", { method: "POST", body: form, headers: { authorization: `Bearer ${ctx.room.hostKey}` } }), ctx.manager, ctx.fixtures, "http://hive.test", {});
    expect(ok.status).toBe(201);
  });

  test("at most two uploads are held at once; the rest are told to retry, and the two that ran both landed", async () => {
    const ctx = await setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => upload(ctx, `burst ${i}`, { mix: tone(1.5) })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 503, 503, 503]);
    expect(results.find((r) => r.status === 503)!.headers.get("retry-after")).toBe("5");
    expect(trackDirs(ctx).length).toBe(2);
    // and the gate reopens
    expect((await upload(ctx, "after", { mix: tone(1.5) })).status).toBe(201);
  });

  test("the library quota is enforced before anything is written", async () => {
    const ctx = await setup();
    const limits = { maxUploadBytes: 64 * 1024 * 1024, libraryQuotaBytes: 400_000 };
    expect((await upload(ctx, "fits 1", { mix: tone(2) }, limits)).status).toBe(201); // ~176 KB each
    expect((await upload(ctx, "fits 2", { mix: tone(2) }, limits)).status).toBe(201);
    const full = await upload(ctx, "does not fit", { mix: tone(2) }, limits);
    expect(full.status).toBe(507);
    expect(full.body.error).toBe("library_full"); // a code the page switches on…
    expect(full.body.message).toContain("library is full"); // …and a sentence it can show
    expect(trackDirs(ctx).length).toBe(2);
    expect(await librarySizeBytes(ctx.fixtures)).toBeLessThanOrEqual(400_000);
  });

  test("a write that fails leaves no half-made track behind", async () => {
    const ctx = await setup();
    writeFileSync(join(ctx.fixtures, "tracks"), "not a directory"); // every mkdir under it fails
    const r = await upload(ctx, "nowhere to go", { mix: tone(2) });
    expect(r.status).toBe(507);
    expect(ctx.manager.getLibrary().some((t) => t.title === "nowhere to go")).toBe(false);
  });

  test("writeMonoWav16 writes exactly encodeMonoWav16's bytes, across its chunk boundary", async () => {
    const dir = tempFixtures();
    for (const n of [0, 1, 524_287, 524_288, 524_289, 1_200_000]) {
      const s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = Math.sin(i / 9) * 1.2; // includes values past full scale
      await writeMonoWav16(join(dir, `${n}.wav`), s, 44100);
      const written = Buffer.from(await Bun.file(join(dir, `${n}.wav`)).arrayBuffer());
      expect(written.equals(Buffer.from(encodeMonoWav16(s, 44100)))).toBe(true);
    }
  });
});

describe("SG-07: parseWav fuzz — any bytes either parse to sane audio or throw a plain Error", () => {
  test("3000 mutated / truncated / lying headers", () => {
    let seed = 0x5eed1234;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const base = wavBytes({ ch: 2, bits: 16, frames: 300, fill: (v, off) => { for (let i = 0; i < 600; i++) v.setInt16(off + i * 2, (i * 997) % 30000, true); } });
    let parsed = 0;
    for (let iter = 0; iter < 3000; iter++) {
      const bytes = base.slice(0, rnd() < 0.3 ? Math.floor(rnd() * base.length) : base.length);
      const mutations = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < mutations && bytes.length > 0; k++) {
        // mostly the header, where the structure lives
        const at = rnd() < 0.8 ? Math.floor(rnd() * Math.min(48, bytes.length)) : Math.floor(rnd() * bytes.length);
        bytes[at] = rnd() < 0.3 ? 0xff : rnd() < 0.5 ? 0 : Math.floor(rnd() * 256);
      }
      let out: ReturnType<typeof parseWav>;
      try {
        out = parseWav(bytes, { maxDurationSec: 600 });
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        continue;
      }
      parsed++;
      expect(out.sampleRate).toBeGreaterThanOrEqual(8000);
      expect(out.sampleRate).toBeLessThanOrEqual(192000);
      expect(out.channels.length).toBe(out.numChannels);
      expect(out.numChannels).toBeGreaterThanOrEqual(1);
      expect(out.numChannels).toBeLessThanOrEqual(8);
      expect(Number.isFinite(out.durationSec)).toBe(true);
      for (const ch of out.channels) {
        expect(ch.length).toBe(out.channels[0]!.length);
        expect(ch.length).toBeLessThanOrEqual(bytes.length); // never more frames than bytes
        for (const s of ch) if (!(s >= -1 && s <= 1)) throw new Error(`sample out of range: ${s}`);
      }
    }
    expect(parsed).toBeGreaterThan(100); // the fuzz does reach the decode loop, not only the rejects
  });
});
