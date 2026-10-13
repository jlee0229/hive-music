import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Audit SG-12: GET /audio/:id/:stem.wav. Verified and pinned: nothing outside tracks/<id>/<stem>.wav
 * is reachable (including the host-key secret that lives beside the tracks), the cache headers let a
 * phone keep a stem forever, and single ranges work. Fixed: `bytes=-N` returned the FIRST N+1 bytes
 * instead of the last N, and the route answered any method (a POST got the whole file).
 */
const PORT = 29080 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const fixtures = mkdtempSync(join(tmpdir(), "hive-audio-"));
const BYTES = 1000;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  mkdirSync(join(fixtures, "tracks", "tone"), { recursive: true });
  writeFileSync(join(fixtures, "tracks", "tone", "mix.wav"), Uint8Array.from({ length: BYTES }, (_, i) => i % 251));
  writeFileSync(join(fixtures, "tracks", "tone", "meta.json"), JSON.stringify({ id: "tone", title: "Tone", durationSec: 5, stems: ["mix"], generated: true }));
  writeFileSync(join(fixtures, "secret.wav"), "outside tracks/");
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", FIXTURES_DIR: fixtures };
  delete env.HOST_KEY_SECRET; // so the server writes tracks/.env.hostkey — which must not be servable
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(async () => {
  proc.kill();
  await proc.exited;
  rmSync(fixtures, { recursive: true, force: true });
});

const body = async (res: Response) => new Uint8Array(await res.arrayBuffer());
const expected = (from: number, to: number) => Uint8Array.from({ length: to - from + 1 }, (_, i) => (from + i) % 251);

describe("SG-12: /audio", () => {
  test("serves the stem whole, cacheable forever, with a length", async () => {
    const res = await fetch(`${BASE}/audio/tone/mix.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe(String(BYTES));
    expect(await body(res)).toEqual(expected(0, BYTES - 1));
  });

  test("ranges: first bytes, open-ended, and the LAST N bytes for a suffix range", async () => {
    const get = (range: string) => fetch(`${BASE}/audio/tone/mix.wav`, { headers: { range } });
    const probe = await get("bytes=0-1");
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${BYTES}`);
    expect(await body(probe)).toEqual(expected(0, 1));

    const tail = await get("bytes=900-");
    expect(tail.headers.get("content-range")).toBe(`bytes 900-999/${BYTES}`);
    expect(await body(tail)).toEqual(expected(900, 999));

    const suffix = await get("bytes=-100");
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes 900-999/${BYTES}`);
    expect(await body(suffix)).toEqual(expected(900, 999));

    const wholeBySuffix = await get("bytes=-5000"); // longer than the file: all of it
    expect(wholeBySuffix.headers.get("content-range")).toBe(`bytes 0-999/${BYTES}`);

    expect((await get("bytes=2000-")).status).toBe(416);
    expect((await get("bytes=5-2")).status).toBe(416);
    expect((await get("bytes=-0")).status).toBe(416);
    expect((await get("bytes=-")).status).toBe(200); // not a range at all: ignored
    expect((await get("bytes=0-1,5-9")).status).toBe(200); // multi-range: not supported, whole file
  });

  test("nothing but tracks/<id>/<stem>.wav is reachable", async () => {
    expect(await Bun.file(join(fixtures, "tracks", ".env.hostkey")).exists()).toBe(true); // the secret really is there
    const paths = [
      "/audio/..%2Fsecret.wav",
      "/audio/%2e%2e/secret.wav",
      "/audio/tone/..%2F..%2Fsecret.wav",
      "/audio/tone/..%5C..%5Csecret.wav",
      "/audio/tone/%2e%2e%2f%2e%2e%2fsecret.wav",
      "/audio/.env.hostkey",
      "/audio/tone/.env.hostkey",
      "/audio/tracks/.env.hostkey.wav",
      "/audio/tone/meta.json",
      "/audio/tone/mix.wav%00.json",
      "/audio//mix.wav",
      "/audio/tone/mix.wav/",
    ];
    for (const p of paths) {
      const res = await fetch(`${BASE}${p}`);
      expect(`${p} → ${res.status}`).toBe(`${p} → 404`);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  test("only GET and HEAD", async () => {
    expect((await fetch(`${BASE}/audio/tone/mix.wav`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${BASE}/audio/tone/mix.wav`, { method: "DELETE" })).status).toBe(405);
    const head = await fetch(`${BASE}/audio/tone/mix.wav`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(BYTES));
  });
});
