import { describe, expect, test } from "bun:test";
import { encodeMonoWav16, parseWav } from "../wav";

function synth(n: number, hz: number, sampleRate: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.5;
  return out;
}

function writeWavHeader(opts: { sampleRate: number; numChannels: number; bitsPerSample: number; audioFormat: number; frames: Uint8Array }): Uint8Array {
  const dataBytes = opts.frames.length;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  const blockAlign = opts.numChannels * (opts.bitsPerSample / 8);
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, opts.audioFormat, true);
  v.setUint16(22, opts.numChannels, true);
  v.setUint32(24, opts.sampleRate, true);
  v.setUint32(28, opts.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, opts.bitsPerSample, true);
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  new Uint8Array(buf, 44).set(opts.frames);
  return new Uint8Array(buf);
}

function pcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  samples.forEach((s, i) => v.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
  return out;
}

function pcm8Bytes(samples: Float32Array): Uint8Array {
  return Uint8Array.from(samples, (s) => Math.round((Math.max(-1, Math.min(1, s)) + 1) * 128));
}

function pcm24Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 3);
  samples.forEach((s, i) => {
    const v = Math.round(Math.max(-1, Math.min(1, s)) * 8388607);
    out[i * 3] = v & 0xff;
    out[i * 3 + 1] = (v >> 8) & 0xff;
    out[i * 3 + 2] = (v >> 16) & 0xff;
  });
  return out;
}

function float32Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 4);
  const v = new DataView(out.buffer);
  samples.forEach((s, i) => v.setFloat32(i * 4, s, true));
  return out;
}

function stereoInterleave(samples: Float32Array): Uint8Array {
  const stereo = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    stereo[i * 2] = samples[i]!;
    stereo[i * 2 + 1] = samples[i]!;
  }
  return pcm16Bytes(stereo);
}

describe("wav parse/encode", () => {
  test("round-trips 16-bit mono PCM", () => {
    const samples = synth(4410, 440, 44100);
    const wav = writeWavHeader({ sampleRate: 44100, numChannels: 1, bitsPerSample: 16, audioFormat: 1, frames: pcm16Bytes(samples) });
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.channels[0]!.length).toBe(4410);
    expect(parsed.channels[0]![100]!).toBeCloseTo(samples[100]!, 3);
  });

  test("reads 8-bit, 24-bit PCM and 32-bit float", () => {
    const samples = synth(1000, 220, 22050);
    for (const [bits, encode, format] of [
      [8, pcm8Bytes, 1],
      [24, pcm24Bytes, 1],
      [32, float32Bytes, 3],
    ] as const) {
      const wav = writeWavHeader({ sampleRate: 22050, numChannels: 1, bitsPerSample: bits, audioFormat: format, frames: encode(samples) });
      const parsed = parseWav(wav);
      expect(parsed.channels[0]!.length).toBe(1000);
      // 8-bit has coarse quantization; give it a looser tolerance than the others
      expect(parsed.channels[0]![500]!).toBeCloseTo(samples[500]!, bits === 8 ? 1 : 2);
    }
  });

  test("downmixes nothing itself — stereo comes back as two channels", () => {
    const samples = synth(500, 330, 44100);
    const wav = writeWavHeader({ sampleRate: 44100, numChannels: 2, bitsPerSample: 16, audioFormat: 1, frames: stereoInterleave(samples) });
    const parsed = parseWav(wav);
    expect(parsed.numChannels).toBe(2);
    expect(parsed.channels).toHaveLength(2);
    expect(parsed.channels[0]![10]).toBeCloseTo(parsed.channels[1]![10]!, 3);
  });

  test("rejects a non-WAV buffer, an unsupported encoding, and a missing fmt/data chunk", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3, 4]))).toThrow();
    const badFormat = writeWavHeader({ sampleRate: 44100, numChannels: 1, bitsPerSample: 16, audioFormat: 6 /* A-law */, frames: new Uint8Array(10) });
    expect(() => parseWav(badFormat)).toThrow(/unsupported WAV encoding/);
  });

  test("encodeMonoWav16 produces a file parseWav reads back correctly", () => {
    const samples = synth(2000, 100, 44100);
    const encoded = encodeMonoWav16(samples, 44100);
    const parsed = parseWav(encoded);
    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.channels[0]!.length).toBe(2000);
    expect(parsed.channels[0]![50]).toBeCloseTo(samples[50]!, 3);
  });
});
