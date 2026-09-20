// Any audio file the phone can play → the upload spec (mono 16-bit 44.1kHz WAV), entirely in the
// browser: decodeAudioData handles MP3/AAC/FLAC/OGG/WAV, an OfflineAudioContext does the
// downmix + resample, and a 44-byte-header encoder writes the bytes. The server then re-checks the
// WAV, computes the analysis (per-second energy curve, drop detection for the vibe director) and
// adds the track to the library. No ffmpeg anywhere in the path.
import type { TrackLibraryEntry } from "@hive/protocol";

/** Mirror of apps/server/src/upload/convert.ts MAX_STEM_SEC — reject before a doomed upload. */
export const MAX_UPLOAD_SEC = 600;
const TARGET_RATE = 44100;

export async function fileToMonoWav(file: File): Promise<Blob> {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const probe = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes);
  } catch {
    throw new Error("couldn't read that file as audio — try an MP3, M4A or WAV");
  } finally {
    probe.close().catch(() => {});
  }
  if (decoded.duration > MAX_UPLOAD_SEC) {
    throw new Error(`that's ${Math.round(decoded.duration)}s of audio — the limit is ${MAX_UPLOAD_SEC / 60} minutes`);
  }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  return new Blob([encodeWav16(mono, TARGET_RATE)], { type: "audio/wav" });
}

/** Minimal RIFF/WAVE writer: 16-bit PCM, one channel — exactly what POST /tracks parses. */
function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export async function postTrack(apiUrl: string, hostKey: string, title: string, wav: Blob): Promise<TrackLibraryEntry> {
  const form = new FormData();
  form.set("hostKey", hostKey);
  form.set("title", title);
  form.set("mix", new File([wav], "mix.wav", { type: "audio/wav" }));
  const res = await fetch(`${apiUrl}/tracks`, { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as { track?: TrackLibraryEntry; error?: string } | null;
  if (!res.ok || !body?.track) throw new Error(body?.error ?? `upload failed (${res.status})`);
  return body.track;
}

/** "01 - Baby [feat. Ludacris].mp3" → "01 - Baby [feat. Ludacris]", capped to the title limit. */
export function titleFromFilename(name: string): string {
  return (name.replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Uploaded track").slice(0, 120);
}
