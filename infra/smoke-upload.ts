// Smoke check used by infra/smoke-test.sh (piped into `bun run -` inside the container) and
// usable against any server:  bun infra/smoke-upload.ts http://localhost:8787
// Does what a host's browser does: creates a room, joins it as host with a library key (uploads
// are owned by the host's browser; a room with no owner cannot upload), uploads a 12-second
// generated click track as `mix`, checks the track is listed as the host's own and that a guest
// with no key can fetch its audio, then removes it again. Exits non-zero on the first thing wrong.
// Still: do not point this at production — a failed run can leave "smoke test" in the library.
const base = (process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 8080}`).replace(/\/$/, "");
const SR = 44100;
const SECONDS = 12;

function clickTrackWav(): Uint8Array {
  const n = SR * SECONDS;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SR, true);
  v.setUint32(28, SR * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  const beat = SR / 2; // 120 BPM
  for (let i = 0; i < n; i++) {
    const p = i % beat;
    const s = p < 2000 ? Math.sin((2 * Math.PI * 90 * p) / SR) * Math.exp(-p / 400) * 0.8 : 0;
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

function fail(msg: string): never {
  console.error(`smoke-upload: FAIL: ${msg}`);
  process.exit(1);
}

const health = await fetch(`${base}/health`).catch((e) => fail(`GET /health: ${e}`));
if (!health.ok) fail(`GET /health -> ${health.status}`);
const { protocolVersion } = (await health.json()) as { protocolVersion: number };

const roomRes = await fetch(`${base}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (!roomRes.ok) fail(`POST /rooms -> ${roomRes.status}`);
const room = (await roomRes.json()) as { code: string; hostKey: string };
const asHost = { authorization: `Bearer ${room.hostKey}` };

// Join as host with a library key, the way the host page does; keep the socket open so the room
// (and with it the key's authority) stays alive for the REST calls below.
const libraryKey = `smoke-${crypto.randomUUID()}`;
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`);
const welcome = await new Promise<{ isHost?: boolean } | string>((resolve) => {
  const timer = setTimeout(() => resolve("no WELCOME within 5 s"), 5000);
  ws.onerror = () => resolve("WebSocket error");
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        type: "JOIN", clientId: `smoke-host-${crypto.randomUUID()}`, roomCode: room.code, kind: "host", plays: false,
        hostKey: room.hostKey, libraryKey, name: "smoke",
        device: { userAgent: "smoke-upload", platform: "smoke", browserFamily: "other" }, protocolVersion,
      }),
    );
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { type: string; isHost?: boolean; code?: string; message?: string };
    if (m.type === "WELCOME") (clearTimeout(timer), resolve(m));
    if (m.type === "ERROR") (clearTimeout(timer), resolve(`ERROR ${m.code}: ${m.message}`));
  };
});
if (typeof welcome === "string") fail(`host JOIN: ${welcome}`);
if (welcome.isHost !== true) fail("host JOIN with the room's own key was not granted host");

const form = new FormData();
form.set("title", "smoke test");
form.set("mix", new File([clickTrackWav()], "mix.wav", { type: "audio/wav" }));
const up = await fetch(`${base}/tracks`, { method: "POST", headers: asHost, body: form });
const upBody = await up.text();
if (up.status !== 201) fail(`POST /tracks -> ${up.status} ${upBody.slice(0, 300)}`);
const track = (JSON.parse(upBody) as { track: { id: string; urls: Record<string, string> } }).track;

const mine = (await (await fetch(`${base}/tracks`, { headers: asHost })).json()) as { tracks: Array<{ id: string; mine?: boolean }> };
if (!mine.tracks.some((t) => t.id === track.id && t.mine === true)) fail(`uploaded track ${track.id} is not listed as the host's own`);
const anon = (await (await fetch(`${base}/tracks`)).json()) as { tracks: Array<{ id: string }> };
if (anon.tracks.some((t) => t.id === track.id)) fail(`uploaded track ${track.id} is visible to a caller with no key`);

// A guest holds no key and must still be able to fetch what the host picked.
const audio = await fetch(`${base}/audio/${track.id}/mix.wav`, { headers: { range: "bytes=0-1" } });
if (audio.status !== 206) fail(`GET /audio/${track.id}/mix.wav with a Range header -> ${audio.status}, expected 206`);

const del = await fetch(`${base}/tracks/${track.id}`, { method: "DELETE", headers: asHost });
if (!del.ok) fail(`DELETE /tracks/${track.id} -> ${del.status}`);
ws.close();

console.log(`smoke-upload: ok room=${room.code} track=${track.id} (uploaded, listed as mine, served, removed)`);
