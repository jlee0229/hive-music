#!/usr/bin/env bun
// How does the server deliver a track, and what does a party cost in bytes and seconds?
//
//   bun apps/server/scripts/audio-delivery.ts [--audio-sec 214] [--phones 50] [--songs 10] [--out <file.json>]
//
// Part 1 probes GET /audio/<id>/<stem>.wav on a locally spawned real server (seeded-noise WAV in a
// temp FIXTURES_DIR, removed afterwards): status and headers for a plain GET, HEAD, single / suffix /
// open / multi ranges, conditional requests, and Accept-Encoding. Part 2 downloads the file with N
// concurrent clients and reports the server's peak RSS and CPU (is it streamed or buffered?).
// Part 3 is arithmetic from the measured size: egress for a party and time-to-ready per link, for the
// WAV as served today and for each candidate encoding.
import { readProcStats } from "./lib/proc-stats";
import { parseArgs } from "./lib/stats";
import { makeTmpFixtures } from "./lib/tmp-fixtures";

const args = parseArgs(process.argv.slice(2));
const AUDIO_SEC = Number(args.get("audio-sec") ?? 214);
const PHONES = Number(args.get("phones") ?? 50);
const SONGS = Number(args.get("songs") ?? 10);
const PORT = 26000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const fixtures = await makeTmpFixtures({ tracks: 1, trackSec: AUDIO_SEC });
const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/index.ts`], {
  env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "", FIXTURES_DIR: fixtures.dir },
  stdout: "ignore",
  stderr: "inherit",
});
const lines: string[] = [];
const say = (l = "") => {
  lines.push(l);
  console.log(l);
};
const result: Record<string, unknown> = { wavBytes: fixtures.wavBytes, audioSec: AUDIO_SEC };
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("server did not start");
    await sleep(100);
  }
  const url = `${BASE}/audio/${fixtures.trackIds[0]}/mix.wav`;
  say(`Audio delivery — ${AUDIO_SEC} s mono 16-bit 44.1 kHz WAV = ${fixtures.wavBytes} bytes (${(fixtures.wavBytes / 1e6).toFixed(1)} MB)`);
  say(`  command: bun apps/server/scripts/audio-delivery.ts ${process.argv.slice(2).join(" ")}`);
  say();
  say(`1. What the server answers`);
  const KEEP = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified", "content-encoding", "vary", "access-control-allow-origin"];
  const probes: Array<[string, RequestInit]> = [
    ["GET", {}],
    ["HEAD", { method: "HEAD" }],
    ["GET Range: bytes=0-1 (the iOS probe)", { headers: { Range: "bytes=0-1" } }],
    ["GET Range: bytes=1000000- (resume)", { headers: { Range: "bytes=1000000-" } }],
    ["GET Range: bytes=-500 (last 500 bytes)", { headers: { Range: "bytes=-500" } }],
    ["GET Range: bytes=0-1,10-11 (multi)", { headers: { Range: "bytes=0-1,10-11" } }],
    ["GET Accept-Encoding: gzip, br", { headers: { "Accept-Encoding": "gzip, br" } }],
  ];
  const headerRows: Record<string, unknown> = {};
  let etag: string | null = null;
  let lastModified: string | null = null;
  const probe = async (label: string, init: RequestInit) => {
    const ctl = new AbortController();
    const res = await fetch(url, { ...init, signal: ctl.signal, decompress: false } as RequestInit);
    const shown = KEEP.filter((h) => res.headers.has(h)).map((h) => `${h}: ${res.headers.get(h)}`);
    etag ??= res.headers.get("etag");
    lastModified ??= res.headers.get("last-modified");
    // Count what actually arrives for the small ones; abort the big ones after the headers.
    let got: number | string = "(not read)";
    const declared = Number(res.headers.get("content-length") ?? -1);
    if (declared >= 0 && declared <= 4096 && init.method !== "HEAD") got = (await res.arrayBuffer()).byteLength;
    else ctl.abort();
    headerRows[label] = { status: res.status, headers: Object.fromEntries(KEEP.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)])), bodyBytes: got };
    say(`  ${label}`);
    say(`    -> ${res.status}  ${shown.join(" | ")}${typeof got === "number" ? `  [body ${got} B]` : ""}`);
  };
  for (const [label, init] of probes) await probe(label, init);
  if (etag) await probe(`GET If-None-Match: ${etag}`, { headers: { "If-None-Match": etag } });
  else say(`  (no ETag in any response, so a revalidation by ETag is impossible)`);
  if (lastModified) await probe(`GET If-Modified-Since: ${lastModified}`, { headers: { "If-Modified-Since": lastModified } });
  else say(`  (no Last-Modified in any response, so If-Modified-Since cannot revalidate either)`);
  result.headers = headerRows;

  say();
  say(`2. ${PHONES} concurrent full downloads (loopback, unthrottled)`);
  const before = await readProcStats(proc.pid);
  let peakKb = before?.rssKb ?? 0;
  const peakTimer = setInterval(async () => {
    const s = await readProcStats(proc.pid);
    if (s && s.rssKb > peakKb) peakKb = s.rssKb;
  }, 250);
  const t0 = performance.now();
  const sizes = await Promise.all(
    Array.from({ length: PHONES }, async () => {
      const res = await fetch(url);
      let n = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) n += chunk.byteLength;
      return n;
    }),
  );
  const wallMs = performance.now() - t0;
  clearInterval(peakTimer);
  const after = await readProcStats(proc.pid);
  const total = sizes.reduce((a, b) => a + b, 0);
  result.concurrent = { phones: PHONES, totalBytes: total, wallMs, rssBeforeKb: before?.rssKb, rssPeakKb: peakKb, rssAfterKb: after?.rssKb, cpuMs: before && after ? after.cpuMs - before.cpuMs : null };
  say(`  ${(total / 1e6).toFixed(0)} MB in ${(wallMs / 1000).toFixed(2)} s = ${((total * 8) / 1e6 / (wallMs / 1000)).toFixed(0)} Mbit/s; every body complete: ${sizes.every((s) => s === fixtures.wavBytes)}`);
  say(`  server RSS before ${((before?.rssKb ?? 0) / 1024).toFixed(0)} MB, peak ${(peakKb / 1024).toFixed(0)} MB, after ${((after?.rssKb ?? 0) / 1024).toFixed(0)} MB  (a fully buffered file per request would be +${((PHONES * fixtures.wavBytes) / 1e6).toFixed(0)} MB)`);
  say(`  server CPU ${before && after ? after.cpuMs - before.cpuMs : "n/a"} ms = ${before && after ? ((after.cpuMs - before.cpuMs) / PHONES).toFixed(1) : "n/a"} ms per download`);

  say();
  say(`3. What a party costs: ${PHONES} phones x ${SONGS} songs of ${AUDIO_SEC} s`);
  const wav = fixtures.wavBytes;
  // WAV sizes are exact (PCM is arithmetic). Lossy sizes are bitrate x duration. FLAC is content-
  // dependent: 55-70 % of the PCM is the usual range for 16-bit pop music — NOT measured here (seeded
  // noise does not compress, and no personal music is read by this script).
  const encodings: Array<[string, number]> = [
    ["WAV 44.1 kHz 16-bit mono (today)", wav],
    ["WAV 32 kHz 16-bit mono", Math.round((wav * 32000) / 44100)],
    ["WAV 22.05 kHz 16-bit mono", Math.round(wav / 2)],
    ["FLAC 44.1 kHz mono (lossless) @ ~60 % of PCM", Math.round(wav * 0.6)],
    ["FLAC 32 kHz mono @ ~60 % of PCM", Math.round(((wav * 32000) / 44100) * 0.6)],
    ["AAC-LC / Opus 96 kbit/s mono", Math.round((96_000 / 8) * AUDIO_SEC)],
    ["Opus 64 kbit/s mono", Math.round((64_000 / 8) * AUDIO_SEC)],
  ];
  const links: Array<[string, number]> = [["50 Mbit/s", 50e6], ["10 Mbit/s", 10e6], ["2 Mbit/s", 2e6]];
  say(`  encoding                                        size     party egress   $ at 0.02/GB   time to download on ${links.map(([n]) => n).join(" / ")}   venue uplink needed for all ${PHONES} phones inside the 5 s advance lead`);
  const table: unknown[] = [];
  for (const [name, bytes] of encodings) {
    const egress = bytes * PHONES * SONGS;
    const times = links.map(([, bps]) => (bytes * 8) / bps);
    const uplink = (bytes * 8 * PHONES) / 5 / 1e6;
    table.push({ name, bytes, partyEgressBytes: egress, usd: (egress / 1e9) * 0.02, secondsPerLink: Object.fromEntries(links.map(([n], i) => [n, times[i]])), mbitForAllIn5s: uplink });
    say(`  ${name.padEnd(46)} ${(bytes / 1e6).toFixed(1).padStart(5)} MB ${(egress / 1e9).toFixed(2).padStart(8)} GB ${((egress / 1e9) * 0.02).toFixed(2).padStart(12)}   ${times.map((t) => `${t.toFixed(1)} s`).join(" / ").padEnd(28)} ${uplink.toFixed(0).padStart(6)} Mbit/s`);
  }
  result.model = { phones: PHONES, songs: SONGS, table };
  const out = args.get("out");
  if (out) {
    await Bun.write(out, JSON.stringify(result, null, 2) + "\n");
    await Bun.write(out.replace(/\.json$/, ".txt"), lines.join("\n") + "\n");
  }
} finally {
  proc.kill();
  await fixtures.cleanup().catch(() => {});
}
process.exit(0);
