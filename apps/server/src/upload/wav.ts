// Pure-TS WAV read/write — no ffmpeg dependency on Fly. Parses RIFF/WAVE PCM and IEEE-float files
// (8/16/24/32-bit, any channel count) into per-channel Float32 samples in [-1, 1], and encodes the
// canonical fixtures format: 16-bit PCM, mono, plain 44-byte header (fixtures/README.md's WAV spec).

export interface ParsedWav {
  sampleRate: number;
  numChannels: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
  durationSec: number;
}

const ASCII = (bytes: Uint8Array, offset: number, len: number) => String.fromCharCode(...bytes.subarray(offset, offset + len));

/** Anything outside this is not audio anyone uploads; it is a header written to make the server work. */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 192000;

/**
 * Throws with a message safe to return to the uploader on any parse failure.
 *
 * Everything the header claims is checked BEFORE a single sample buffer is allocated (audit SG-07):
 * the Float32 output is 2-4x the size of the file, so "parse first, measure after" let a 100 MB
 * upload that was always going to be refused take 600 MB of RAM on its way to the refusal.
 */
export function parseWav(buf: Uint8Array, limits: { maxDurationSec?: number; truncateSec?: number } = {}): ParsedWav {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 12 || ASCII(buf, 0, 4) !== "RIFF" || ASCII(buf, 8, 4) !== "WAVE") {
    throw new Error("not a WAV file (missing RIFF/WAVE header)");
  }

  let offset = 12;
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataOffset = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = ASCII(buf, offset, 4);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) throw new Error("WAV file has a truncated fmt chunk");
      fmt = {
        audioFormat: v.getUint16(body, true),
        numChannels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataLen = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV file has no fmt chunk");
  if (dataOffset < 0) throw new Error("WAV file has no data chunk");
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) throw new Error(`unsupported WAV encoding (audioFormat ${fmt.audioFormat}); expected PCM or IEEE float`);
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) throw new Error(`unsupported bit depth ${fmt.bitsPerSample}`);
  if (fmt.numChannels < 1 || fmt.numChannels > 8) throw new Error(`unsupported channel count ${fmt.numChannels}`);

  if (fmt.sampleRate < MIN_SAMPLE_RATE || fmt.sampleRate > MAX_SAMPLE_RATE) throw new Error(`unsupported sample rate ${fmt.sampleRate} Hz`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.numChannels;
  const totalFrames = Math.floor(dataLen / frameBytes);
  if (limits.maxDurationSec !== undefined && totalFrames / fmt.sampleRate > limits.maxDurationSec) {
    throw new Error(`stem is ${(totalFrames / fmt.sampleRate).toFixed(1)}s, over the ${limits.maxDurationSec}s limit`);
  }
  // truncateSec: decode only the head of the file (the startup tempo backfill needs two minutes of it).
  const frameCount = limits.truncateSec !== undefined ? Math.min(totalFrames, Math.floor(limits.truncateSec * fmt.sampleRate)) : totalFrames;
  const durationSec = frameCount / fmt.sampleRate;
  const channels: Float32Array[] = Array.from({ length: fmt.numChannels }, () => new Float32Array(frameCount));

  for (let f = 0; f < frameCount; f++) {
    const frameStart = dataOffset + f * frameBytes;
    for (let c = 0; c < fmt.numChannels; c++) {
      const s = frameStart + c * bytesPerSample;
      let sample: number;
      if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        sample = v.getFloat32(s, true);
        // A float file can hold NaN/Infinity (and values past full scale). One of them turns the
        // energy curve and the tempo into NaN, which JSON writes as null into meta.json.
        if (!(sample >= -1 && sample <= 1)) sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      } else if (fmt.bitsPerSample === 8) {
        sample = (buf[s]! - 128) / 128; // 8-bit PCM is unsigned
      } else if (fmt.bitsPerSample === 16) {
        sample = v.getInt16(s, true) / 32768;
      } else if (fmt.bitsPerSample === 24) {
        const b0 = buf[s]!;
        const b1 = buf[s + 1]!;
        const b2 = buf[s + 2]!;
        let i = b0 | (b1 << 8) | (b2 << 16);
        if (i & 0x800000) i |= ~0xffffff; // sign-extend 24 -> 32 bits
        sample = i / 8388608;
      } else {
        sample = v.getInt32(s, true) / 2147483648; // 32-bit PCM
      }
      channels[c]![f] = sample;
    }
  }

  return { sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, channels, durationSec };
}

/** 44-byte RIFF/WAVE header + 16-bit little-endian PCM, mono — the exact shape fixtures/gen-synthetic.ts writes. */
export function encodeMonoWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
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
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * encodeMonoWav16 straight to disk, 1 MiB of PCM at a time: byte-for-byte the same file, without a
 * second whole-track buffer in memory (53 MB for a 10-minute song, on top of its Float32 samples).
 * The directory must exist.
 */
export async function writeMonoWav16(path: string, samples: Float32Array, sampleRate: number): Promise<void> {
  const CHUNK_SAMPLES = 524_288;
  const header = encodeMonoWav16(new Float32Array(0), sampleRate);
  const hv = new DataView(header.buffer);
  hv.setUint32(4, 36 + samples.length * 2, true);
  hv.setUint32(40, samples.length * 2, true);
  const sink = Bun.file(path).writer();
  try {
    sink.write(header);
    for (let start = 0; start < samples.length; start += CHUNK_SAMPLES) {
      sink.write(encodeMonoWav16(samples.subarray(start, start + CHUNK_SAMPLES), sampleRate).subarray(44));
      await sink.flush();
    }
  } finally {
    await sink.end();
  }
}
