/**
 * Minimal WAV reader for the measurement rig: enough RIFF parsing to load a recording made by anything
 * (phone voice memo exported to WAV, `ffmpeg`, Audacity) without a dependency.
 *
 * Supports 16/24/32-bit PCM and 32-bit float, any channel count (channels are averaged — a phone
 * recording is effectively mono and averaging raises the click above the noise floor).
 */
export interface Wav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  durationSec: number;
}

export function decodeWav(bytes: Uint8Array): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let format = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let dataAt = -1;
  let dataLen = 0;

  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the extension
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataAt = body;
      dataLen = Math.min(size, bytes.byteLength - body);
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataAt < 0) throw new Error("no data chunk");

  const bytesPerSample = bits >> 3;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const out = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataAt + (f * channels + c) * bytesPerSample;
      if (format === 3 && bits === 32) sum += view.getFloat32(off, true);
      else if (bits === 16) sum += view.getInt16(off, true) / 32768;
      else if (bits === 24) {
        const lo = bytes[off]!;
        const mid = bytes[off + 1]!;
        const hi = view.getInt8(off + 2);
        sum += ((hi << 16) | (mid << 8) | lo) / 8388608;
      } else if (bits === 32) sum += view.getInt32(off, true) / 2147483648;
      else if (bits === 8) sum += (bytes[off]! - 128) / 128;
      else throw new Error(`unsupported bit depth ${bits}`);
    }
    out[f] = sum / channels;
  }

  return { samples: out, sampleRate, channels, durationSec: frames / sampleRate };
}

export async function readWav(path: string): Promise<Wav> {
  return decodeWav(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

/** 16-bit mono PCM WAV, for the rig's synthetic recordings. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}
