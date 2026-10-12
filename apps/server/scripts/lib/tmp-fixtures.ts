// A throw-away FIXTURES_DIR for load scripts: N "real" (generated:false) mono 16-bit 44.1 kHz tracks of
// seeded noise, written under the OS temp dir and removed by `cleanup()`. Nothing here ever lands in
// the repo (audio is never committed), and no personal music is read.
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BPM_ALGORITHM_VERSION } from "../../src/upload/bpm";
import { rng } from "./stats";

export interface TmpFixtures {
  dir: string;
  trackIds: string[];
  /** Bytes of one track's mix.wav (header included). */
  wavBytes: number;
  cleanup(): Promise<void>;
}

export function wavOfNoise(durationSec: number, sampleRate = 44100, seed = 1): Uint8Array {
  const frames = Math.round(durationSec * sampleRate);
  const buf = new ArrayBuffer(44 + frames * 2);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, frames * 2, true);
  const rand = rng(seed);
  const pcm = new Int16Array(buf, 44, frames);
  for (let i = 0; i < frames; i++) pcm[i] = Math.round((rand() * 2 - 1) * 8000);
  return new Uint8Array(buf);
}

/**
 * `trackSec` is the *declared* duration (what the playlist timer runs on); `audioSec` is how much audio
 * the WAV really holds (what a phone downloads). They differ on purpose: a playlist-advance run wants
 * an 8-second "song" that still weighs 18.9 MB.
 */
export async function makeTmpFixtures(opts: { tracks: number; trackSec: number; audioSec?: number }): Promise<TmpFixtures> {
  const dir = join(tmpdir(), `hive-load-fixtures-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  const trackIds: string[] = [];
  let wavBytes = 0;
  for (let i = 0; i < opts.tracks; i++) {
    const id = `load-track-${i + 1}`;
    trackIds.push(id);
    await mkdir(join(dir, "tracks", id), { recursive: true });
    const wav = wavOfNoise(opts.audioSec ?? opts.trackSec, 44100, i + 1);
    wavBytes = wav.byteLength;
    await Bun.write(join(dir, "tracks", id, "mix.wav"), wav);
    await Bun.write(
      join(dir, "tracks", id, "meta.json"),
      JSON.stringify({
        id,
        title: `Load Track ${i + 1}`,
        durationSec: opts.trackSec,
        sampleRate: 44100,
        stems: ["mix"],
        order: i,
        generated: false,
        // Pre-stamped so the server's startup tempo backfill skips these (it would burn CPU on noise).
        bpm: 120,
        bpmVersion: BPM_ALGORITHM_VERSION,
        beatOffsetSec: 0,
      }),
    );
  }
  return { dir, trackIds, wavBytes, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
