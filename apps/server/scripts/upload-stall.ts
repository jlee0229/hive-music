#!/usr/bin/env bun
// What does one host uploading a song do to every other room on the same server?
//
//   bun apps/server/scripts/upload-stall.ts [--audio-sec 214] [--out <file.json>]
//
// POST /tracks parses, resamples and tempo-analyses the upload synchronously inside the request
// handler. While that runs, the single event loop answers nobody: no NTP_RESPONSE, no ROOM_STATE, no
// /health. This probe spawns a real server on localhost (temp FIXTURES_DIR, removed afterwards), joins
// one phone in a *different* room that probes NTP at 20 Hz, uploads a seeded-noise mono WAV of
// --audio-sec seconds, and reports the longest gap that phone saw plus the server's peak RSS.
import { PROTOCOL_VERSION } from "@hive/protocol";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcStats } from "./lib/proc-stats";
import { parseArgs, summarize } from "./lib/stats";
import { wavOfNoise } from "./lib/tmp-fixtures";

const args = parseArgs(process.argv.slice(2));
const AUDIO_SEC = Number(args.get("audio-sec") ?? 214);
const PORT = 26000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.timeOrigin + performance.now();

const dir = join(tmpdir(), `hive-upload-stall-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
await mkdir(join(dir, "tracks"), { recursive: true });
const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/index.ts`], {
  env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "", FIXTURES_DIR: dir, LIBRARY_SCOPE: "global" /* no host JOIN here, so no library owner */ },
  stdout: "ignore",
  stderr: "inherit",
});
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("server did not start");
    await sleep(100);
  }
  const mk = async () => (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json())) as { code: string; hostKey: string };
  const uploader = await mk();
  const bystander = await mk();

  // The bystander: a phone in another room, probing at 20 Hz.
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const rtts: Array<{ at: number; rtt: number }> = [];
  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    if (!raw.startsWith('{"type":"NTP_RESPONSE"')) return;
    const m = JSON.parse(raw) as { t0: number };
    rtts.push({ at: now(), rtt: now() - m.t0 });
  };
  ws.send(JSON.stringify({ type: "JOIN", clientId: crypto.randomUUID(), roomCode: bystander.code, kind: "player", plays: true, device: { userAgent: "", platform: "probe", browserFamily: "other" }, protocolVersion: PROTOCOL_VERSION }));
  const probe = setInterval(() => ws.send(JSON.stringify({ type: "NTP_REQUEST", t0: now() })), 50);
  await sleep(1500);
  const quiet = summarize(rtts.map((r) => r.rtt));

  const wav = wavOfNoise(AUDIO_SEC);
  const form = new FormData();
  form.set("hostKey", uploader.hostKey);
  form.set("title", "Upload stall probe");
  form.set("mix", new File([wav.buffer as ArrayBuffer], "mix.wav", { type: "audio/wav" }));
  const before = await readProcStats(proc.pid);
  let peakKb = before?.rssKb ?? 0;
  const peakTimer = setInterval(async () => {
    const s = await readProcStats(proc.pid);
    if (s && s.rssKb > peakKb) peakKb = s.rssKb;
  }, 150);
  const mark = rtts.length;
  const t0 = performance.now();
  const res = await fetch(`${BASE}/tracks`, { method: "POST", body: form });
  const uploadMs = performance.now() - t0;
  await sleep(1500);
  clearInterval(peakTimer);
  clearInterval(probe);
  const after = await readProcStats(proc.pid);
  const during = rtts.slice(mark);
  const worst = Math.max(...during.map((r) => r.rtt));
  let longestGap = 0;
  for (let i = Math.max(1, mark); i < rtts.length; i++) longestGap = Math.max(longestGap, rtts[i]!.at - rtts[i - 1]!.at);

  const lines = [
    `Upload stall: a ${AUDIO_SEC} s mono WAV (${(wav.byteLength / 1e6).toFixed(1)} MB) uploaded to room ${uploader.code}; a phone in room ${bystander.code} probes NTP at 20 Hz`,
    `  command: bun apps/server/scripts/upload-stall.ts ${process.argv.slice(2).join(" ")}`,
    `  POST /tracks -> ${res.status} after ${uploadMs.toFixed(0)} ms; server CPU ${before && after ? after.cpuMs - before.cpuMs : "n/a"} ms`,
    `  bystander NTP round trip before the upload: p50=${quiet.p50.toFixed(2)} max=${quiet.max.toFixed(2)} ms`,
    `  bystander NTP during the upload: worst round trip ${worst.toFixed(0)} ms, longest silence between answers ${longestGap.toFixed(0)} ms (LEAD_MS is 600: a PLAY issued inside that window starts late)`,
    `  server RSS before ${((before?.rssKb ?? 0) / 1024).toFixed(0)} MB, peak ${(peakKb / 1024).toFixed(0)} MB (+${((peakKb - (before?.rssKb ?? 0)) / 1024).toFixed(0)} MB = ${((peakKb - (before?.rssKb ?? 0)) / 1024 / (wav.byteLength / 1e6)).toFixed(1)}x the file), after ${((after?.rssKb ?? 0) / 1024).toFixed(0)} MB`,
  ];
  console.log(lines.join("\n"));
  const out = args.get("out");
  if (out) {
    await Bun.write(out, JSON.stringify({ audioSec: AUDIO_SEC, wavBytes: wav.byteLength, status: res.status, uploadMs, worstRttMs: worst, longestGapMs: longestGap, rssBeforeKb: before?.rssKb, rssPeakKb: peakKb, rssAfterKb: after?.rssKb, cpuMs: before && after ? after.cpuMs - before.cpuMs : null }, null, 2) + "\n");
    await Bun.write(out.replace(/\.json$/, ".txt"), lines.join("\n") + "\n");
  }
  ws.close();
} finally {
  proc.kill();
  await proc.exited;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
