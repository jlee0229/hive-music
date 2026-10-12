// Any audio file the phone can play → the upload spec (mono 16-bit 44.1kHz WAV), entirely in the
// browser: decodeAudioData handles MP3/AAC/FLAC/OGG/WAV, an OfflineAudioContext does the
// downmix + resample, and a 44-byte-header encoder writes the bytes. The server then re-checks the
// WAV, computes the analysis (per-second energy curve, drop detection for the vibe director) and
// adds the track to the library. No ffmpeg anywhere in the path.
//
// Memory, because this runs on the host's phone mid-party: decoding is the expensive step — 4 bytes
// per sample per channel at the device rate, so a 10-minute stereo song is ~230 MB decoded (48 kHz),
// plus ~106 MB for the mono render and ~53 MB each for the WAV bytes and the Blob. A file is
// therefore refused *before* it is decoded whenever its size or its own header says it is over the
// limit: an hour-long mix would otherwise need ~1.4 GB just to be told it is too long.
import type { TrackLibraryEntry } from "@hive/protocol";

/** Mirror of apps/server/src/upload/convert.ts MAX_STEM_SEC — reject before a doomed upload. */
export const MAX_UPLOAD_SEC = 600;
/** Larger than any 10-minute audio file (24-bit/48 kHz stereo WAV is ~173 MB); anything above is a video or a long recording. */
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;
const TARGET_RATE = 44100;

/** What the Songs drawer shows, as is. Plain words: no status codes, no error identifiers. */
export const UPLOAD_ERRORS = {
  notAudio: "couldn't read that file as audio — try an MP3, M4A or WAV",
  tooBig: `that file is too big — the limit is ${MAX_UPLOAD_SEC / 60} minutes of audio`,
  tooLong: (sec: number) => `that song is ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")} long — the limit is ${MAX_UPLOAD_SEC / 60} minutes`,
  network: "the upload didn't get through — check the connection and try again",
  notHost: "this phone can't add songs right now — reload the page and try again",
} as const;

/**
 * The duration the file's own header declares, read by a media element without decoding the audio.
 * null when the browser cannot tell (unknown container, a stream with no length) or does not answer
 * in time — the caller then finds out the slow way.
 */
export function probeDurationSec(file: File, timeoutMs = 4000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof Audio === "undefined") return resolve(null);
    const url = URL.createObjectURL(file);
    const el = new Audio();
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

/** Decode + downmix + resample. Its locals (the decoded stereo buffer above all) are garbage before the WAV is built. */
async function decodeToMono(file: File): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const probe = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes);
  } catch {
    throw new Error(UPLOAD_ERRORS.notAudio);
  } finally {
    probe.close().catch(() => {});
  }
  if (decoded.duration > MAX_UPLOAD_SEC) throw new Error(UPLOAD_ERRORS.tooLong(decoded.duration));
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}

export async function fileToMonoWav(file: File): Promise<Blob> {
  if (file.size > MAX_UPLOAD_FILE_BYTES) throw new Error(UPLOAD_ERRORS.tooBig);
  const declaredSec = await probeDurationSec(file);
  // A second of slack: container headers round, and the decoded length is the authority below.
  if (declaredSec !== null && declaredSec > MAX_UPLOAD_SEC + 1) throw new Error(UPLOAD_ERRORS.tooLong(declaredSec));
  const mono = await decodeToMono(file);
  return new Blob([encodeWav16(mono, TARGET_RATE)], { type: "audio/wav" });
}

/** Minimal RIFF/WAVE writer: 16-bit PCM, one channel — exactly what POST /tracks parses. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
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

/** A sentence for a failed POST /tracks. `status` 0 = the request never got an answer. */
export function uploadErrorMessage(status: number, body: { error?: unknown } | null): string {
  if (status === 0 || status >= 500) return UPLOAD_ERRORS.network;
  if (status === 401 || status === 403) return UPLOAD_ERRORS.notHost;
  if (status === 413) return UPLOAD_ERRORS.tooBig;
  const detail = typeof body?.error === "string" ? body.error : "";
  // Server validation messages are sentences ("stem 'mix': not a RIFF/WAVE file"); bare identifiers are not for the host.
  return detail && /[a-z] [a-z]/.test(detail) ? detail : `the upload was refused (${status})`;
}

/**
 * POST /tracks. XMLHttpRequest rather than fetch for one reason: upload progress — the body is up to
 * ~53 MB of WAV going out over party Wi-Fi, and "Uploading…" with no number looks hung.
 */
export function postTrack(apiUrl: string, hostKey: string, title: string, wav: Blob, onProgress?: (fraction: number) => void): Promise<TrackLibraryEntry> {
  const form = new FormData();
  form.set("hostKey", hostKey);
  form.set("title", title);
  form.set("mix", new File([wav], "mix.wav", { type: "audio/wav" }));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiUrl}/tracks`);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    const failed = () => reject(new Error(uploadErrorMessage(0, null)));
    xhr.onerror = failed;
    xhr.onabort = failed;
    xhr.ontimeout = failed;
    xhr.onload = () => {
      let body: { track?: TrackLibraryEntry; error?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON: handled as a refusal below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.track) resolve(body.track);
      else reject(new Error(uploadErrorMessage(xhr.status, body)));
    };
    xhr.send(form);
  });
}

/** "01 - Baby [feat. Ludacris].mp3" → "01 - Baby [feat. Ludacris]", capped to the title limit. */
export function titleFromFilename(name: string): string {
  return (name.replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Uploaded track").slice(0, 120);
}
