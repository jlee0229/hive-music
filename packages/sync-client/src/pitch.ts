/**
 * Offline pitch shifting for CHOIR: each phone re-renders its copy of the song at its assigned
 * pitch when the assignment arrives. SoundTouch (WSOLA time-stretch + transpose, via the
 * soundtouchjs port) keeps the duration identical, so the shared timeline is untouched — a
 * playbackRate shift would have changed speed and drifted the phone away from the room within
 * seconds. The render is chunked with event-loop yields so a 3-minute track doesn't freeze the UI.
 */
import { SimpleFilter, SoundTouch } from "soundtouchjs";

/** Samples processed between yields: ~5 seconds of audio per slice keeps the page responsive. */
const YIELD_EVERY_SAMPLES = 44100 * 5;

/** Pure mono in / mono out (soundtouchjs works in stereo frames internally; we mirror the channel). */
export async function pitchShiftMono(input: Float32Array, semitones: number): Promise<Float32Array> {
  if (semitones === 0) return input;
  const st = new SoundTouch();
  st.tempo = 1.0;
  st.pitchSemitones = semitones;
  const source = {
    extract(target: Float32Array, numFrames: number, position: number): number {
      const frames = Math.min(numFrames, Math.max(0, input.length - position));
      for (let i = 0; i < frames; i++) {
        const s = input[position + i]!;
        target[i * 2] = s;
        target[i * 2 + 1] = s;
      }
      return frames;
    },
  };
  const filter = new SimpleFilter(source, st);

  // Output pinned to the input's length: WSOLA can come up a few hundred samples short at the
  // tail, and that remainder stays silent rather than shifting the timeline mapping.
  const out = new Float32Array(input.length);
  const CHUNK_FRAMES = 16384;
  const chunk = new Float32Array(CHUNK_FRAMES * 2);
  let written = 0;
  let sinceYield = 0;
  for (;;) {
    const frames = filter.extract(chunk, CHUNK_FRAMES);
    if (frames <= 0) break;
    const take = Math.min(frames, input.length - written);
    for (let i = 0; i < take; i++) out[written + i] = chunk[i * 2]!;
    written += take;
    if (written >= input.length) break;
    sinceYield += take;
    if (sinceYield >= YIELD_EVERY_SAMPLES) {
      sinceYield = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}
