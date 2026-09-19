/** B0: every REST route in docs/02-protocol.md §6, in-process on a random port. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, TrackLibraryResponseSchema, CreateRoomResponseSchema, HealthResponseSchema } from "@hive/protocol";
import { createServer } from "../server";

const PORT = 21080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
let hive: ReturnType<typeof createServer>;

beforeAll(async () => {
  hive = createServer({ port: PORT, corsOrigin: "http://localhost:3000", roomFixedCode: "DEMO", quiet: true });
  await hive.ready;
});
afterAll(() => hive.stop());

describe("REST", () => {
  test("GET /health", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    // serverTime is the performance clock, not Date.now(): it must still be a sane epoch ms value.
    expect(body.serverTime).toBeGreaterThan(1_600_000_000_000);
  });

  test("OPTIONS preflight is answered on every path", async () => {
    for (const path of ["/health", "/rooms", "/tracks", "/audio/synthetic-60s/drums.wav"]) {
      const res = await fetch(`${BASE}${path}`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    }
  });

  test("POST /rooms is idempotent under ROOM_FIXED_CODE and keeps the hostKey", async () => {
    const first = CreateRoomResponseSchema.parse(await (await fetch(`${BASE}/rooms`, { method: "POST" })).json());
    expect(first.code).toBe("DEMO");
    expect(first.joinUrl).toContain("/j/DEMO");
    const second = CreateRoomResponseSchema.parse(await (await fetch(`${BASE}/rooms`, { method: "POST" })).json());
    expect(second.code).toBe("DEMO");
    expect(second.hostKey).toBe(first.hostKey);
  });

  test("GET /rooms/:code reports existence and player count", async () => {
    const known = await fetch(`${BASE}/rooms/DEMO`);
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({ code: "DEMO", exists: true, players: 0 });
    const unknown = await fetch(`${BASE}/rooms/ZZZZ`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).exists).toBe(false);
  });

  test("GET /tracks?q= lists the fixture library with absolute stem urls", async () => {
    const all = TrackLibraryResponseSchema.parse(await (await fetch(`${BASE}/tracks`)).json());
    expect(all.tracks.length).toBeGreaterThan(0);
    const synth = all.tracks.find((t) => t.id === "synthetic-60s")!;
    expect(synth.stems).toEqual(["drums", "bass", "vocals", "other"]);
    expect(synth.urls.drums).toBe(`${BASE}/audio/synthetic-60s/drums.wav`);
    expect(synth.energy?.length).toBe(60);
    expect(TrackLibraryResponseSchema.parse(await (await fetch(`${BASE}/tracks?q=nothinghere`)).json()).tracks).toHaveLength(0);
    expect(TrackLibraryResponseSchema.parse(await (await fetch(`${BASE}/tracks?q=syn`)).json()).tracks.length).toBe(1);
  });

  test("GET /audio/:id/:stem.wav serves a cacheable WAV and refuses unknown stems", async () => {
    const res = await fetch(`${BASE}/audio/synthetic-60s/drums.wav`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toContain("public");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(bytes.byteLength).toBeGreaterThan(44 + 60 * 44100); // 60 s of 16-bit mono

    expect((await fetch(`${BASE}/audio/synthetic-60s/nope.wav`)).status).toBe(404);
    expect((await fetch(`${BASE}/audio/../../etc/passwd`)).status).toBe(404);
  });

  test("a Range request gets a 206 slice (iOS media probing)", async () => {
    const res = await fetch(`${BASE}/audio/synthetic-60s/drums.wav`, { headers: { Range: "bytes=0-43" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-43\/\d+$/);
    expect((await res.arrayBuffer()).byteLength).toBe(44);
  });

  test("unknown routes 404 with CORS headers", async () => {
    const res = await fetch(`${BASE}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
