// Smoke check used by infra/smoke-test.sh (piped into `bun run -` inside the container) and
// usable against any server:  bun infra/smoke-upload.ts http://localhost:8787
// Creates a room, uploads a 12-second generated click track as `mix`, and checks the track is
// listed and its audio is served. Exits non-zero on the first thing that is wrong.
// Never point this at production: it leaves a track called "smoke test" in the library.
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

const roomRes = await fetch(`${base}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
if (!roomRes.ok) fail(`POST /rooms -> ${roomRes.status}`);
const room = (await roomRes.json()) as { code: string; hostKey: string };

const form = new FormData();
form.set("hostKey", room.hostKey);
form.set("title", "smoke test");
form.set("mix", new File([clickTrackWav()], "mix.wav", { type: "audio/wav" }));
const up = await fetch(`${base}/tracks`, { method: "POST", body: form });
const upBody = await up.text();
if (up.status !== 201) fail(`POST /tracks -> ${up.status} ${upBody.slice(0, 300)}`);
const track = (JSON.parse(upBody) as { track: { id: string; urls: Record<string, string> } }).track;

const list = (await (await fetch(`${base}/tracks`)).json()) as { tracks: Array<{ id: string }> };
if (!list.tracks.some((t) => t.id === track.id)) fail(`uploaded track ${track.id} is not in GET /tracks`);

const audio = await fetch(`${base}/audio/${track.id}/mix.wav`, { headers: { range: "bytes=0-1" } });
if (audio.status !== 206) fail(`GET /audio/${track.id}/mix.wav with a Range header -> ${audio.status}, expected 206`);

console.log(`smoke-upload: ok room=${room.code} track=${track.id}`);
