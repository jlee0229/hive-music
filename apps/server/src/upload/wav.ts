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

/** Throws with a message safe to return to the uploader on any parse failure. */
export function parseWav(buf: Uint8Array): ParsedWav {
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

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.numChannels;
  const frameCount = Math.floor(dataLen / frameBytes);
  const channels: Float32Array[] = Array.from({ length: fmt.numChannels }, () => new Float32Array(frameCount));

  for (let f = 0; f < frameCount; f++) {
    const frameStart = dataOffset + f * frameBytes;
    for (let c = 0; c < fmt.numChannels; c++) {
      const s = frameStart + c * bytesPerSample;
      let sample: number;
      if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        sample = v.getFloat32(s, true);
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

  return { sampleRate: fmt.sampleRate, numChannels: fmt.numChannels, channels, durationSec: fmt.sampleRate > 0 ? frameCount / fmt.sampleRate : 0 };
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
