import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@hive/protocol";
import { encodeMonoWav16 } from "../wav";

const PORT = 25080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const FIXTURES_DIR = `${import.meta.dir}/../../../../../fixtures`;
let proc: ReturnType<typeof Bun.spawn>;
const uploadedIds: string[] = [];

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/../../index.ts`], { env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "" }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(async () => {
  proc.kill();
  await Promise.all(uploadedIds.map((id) => rm(`${FIXTURES_DIR}/tracks/${id}`, { recursive: true, force: true }).catch(() => {})));
});

function synthWavFile(name: string, n: number, hz: number, sampleRate = 44100): File {
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5;
  const wav = encodeMonoWav16(samples, sampleRate);
  return new File([wav as unknown as BlobPart], name, { type: "audio/wav" });
}

async function makeRoom(): Promise<{ code: string; hostKey: string }> {
  return fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json());
}

describe("POST /tracks (B9 upload)", () => {
  test("rejects without a valid hostKey", async () => {
    const form = new FormData();
    form.set("title", "No Auth");
    form.set("mix", synthWavFile("mix.wav", 44100, 440));
    const res = await fetch(`${BASE}/tracks`, { method: "POST", body: form });
    expect(res.status).toBe(403);
  });

  test("rejects mixing 'mix' with named stems, and rejects an empty upload", async () => {
    const { hostKey } = await makeRoom();
    const mixed = new FormData();
    mixed.set("hostKey", hostKey);
    mixed.set("title", "Bad");
    mixed.set("mix", synthWavFile("mix.wav", 4410, 440));
    mixed.set("drums", synthWavFile("drums.wav", 4410, 100));
    expect((await fetch(`${BASE}/tracks`, { method: "POST", body: mixed })).status).toBe(400);

    const empty = new FormData();
    empty.set("hostKey", hostKey);
    empty.set("title", "Bad");
    expect((await fetch(`${BASE}/tracks`, { method: "POST", body: empty })).status).toBe(400);
  });

  test("rejects a stem over 60s with a clear message", async () => {
    const { hostKey } = await makeRoom();
    const form = new FormData();
    form.set("hostKey", hostKey);
    form.set("title", "Too Long");
    form.set("mix", synthWavFile("mix.wav", 44100 * 61, 440));
    const res = await fetch(`${BASE}/tracks`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/60s limit/);
  });

  test("a single-file 'mix' upload is stored, appears in GET /tracks, and its audio is servable", async () => {
    const { hostKey } = await makeRoom();
    const form = new FormData();
    form.set("hostKey", hostKey);
    form.set("title", "My Mix Upload");
    form.set("mix", synthWavFile("mix.wav", 44100 * 2, 330)); // 2s
    const res = await fetch(`${BASE}/tracks`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { track } = await res.json();
    uploadedIds.push(track.id);
    expect(track.stems).toEqual(["mix"]);
    expect(track.durationSec).toBeCloseTo(2, 1);
    expect(track.energy.length).toBeGreaterThan(0);
    expect(track.urls.mix).toBe(`${BASE}/audio/${track.id}/mix.wav`);

    const list = await fetch(`${BASE}/tracks?q=My+Mix`).then((r) => r.json());
    expect(list.tracks.some((t: { id: string }) => t.id === track.id)).toBe(true);

    const audio = await fetch(track.urls.mix);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
  });

  test("a multi-stem upload (drums+bass) computes meta from all stems together", async () => {
    const { hostKey } = await makeRoom();
    const form = new FormData();
    form.set("hostKey", hostKey);
    form.set("title", "Two Stems");
    form.set("drums", synthWavFile("drums.wav", 44100, 100));
    form.set("bass", synthWavFile("bass.wav", 44100, 55));
    const res = await fetch(`${BASE}/tracks`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { track } = await res.json();
    uploadedIds.push(track.id);
    expect(track.stems.sort()).toEqual(["bass", "drums"]);
    expect(Object.keys(track.urls).sort()).toEqual(["bass", "drums"]);
  });

  test("GET /audio honours a Range request (iOS Safari probes with bytes=0-1)", async () => {
    const { hostKey } = await makeRoom();
    const form = new FormData();
    form.set("hostKey", hostKey);
    form.set("title", "Range Test");
    form.set("mix", synthWavFile("mix.wav", 44100, 440));
    const { track } = await (await fetch(`${BASE}/tracks`, { method: "POST", body: form })).json();
    uploadedIds.push(track.id);

    const res = await fetch(track.urls.mix, { headers: { Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-1\//);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(2);
  });

  test("SET_TRACK can load an uploaded track over the real WebSocket protocol", async () => {
    const { code, hostKey } = await makeRoom();
    const form = new FormData();
    form.set("hostKey", hostKey);
    form.set("title", "WS Load Test");
    form.set("mix", synthWavFile("mix.wav", 44100, 440));
    const { track } = await (await fetch(`${BASE}/tracks`, { method: "POST", body: form })).json();
    uploadedIds.push(track.id);

    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const inbox: unknown[] = [];
    ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
    const device = { userAgent: "t", platform: "t", browserFamily: "desktop-chrome" };
    ws.send(JSON.stringify({ type: "JOIN", clientId: "host-upload-01", roomCode: code, kind: "host", plays: false, hostKey, device, protocolVersion: PROTOCOL_VERSION }));
    ws.send(JSON.stringify({ type: "SET_TRACK", trackId: track.id }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 3000);
      const iv = setInterval(() => {
        const m = inbox.find((x): x is { type: string; room: { track: { id: string } | null } } => (x as { type: string }).type === "ROOM_STATE" && (x as { room: { track: { id: string } | null } }).room.track?.id === track.id);
        if (m) {
          clearInterval(iv);
          clearTimeout(t);
          resolve(m);
        }
      }, 20);
    });
    ws.close();
  });
});
