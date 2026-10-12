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

/**
 * How far SoundTouch's raw output trails its input, in samples (negative: the output is early).
 *
 * Same length is not the same timeline. WSOLA emits each `seekWindowLength` window of its input
 * at the window's *start* position on the output timeline, and it picks that window up to
 * `seekLength` ahead of nominal (half of that on average over music), so the content is displaced
 * by half a window times the stretch amount, plus the mean seek. Measured on a 4-minute track,
 * constant from first second to last: +12 st plays 43 ms EARLY, +7 st 34 ms early, -12 st 22 ms
 * LATE — a 65 ms flam between the soprano and basso phones in a room whose whole budget is 25 ms.
 * Derived from the stretcher's own window sizes so it holds for any shift, not just CHOIR's three.
 */
function rawLagSamples(st: SoundTouch): number {
  const { seekWindowLength, seekLength } = st.stretch;
  const half = seekWindowLength / 2;
  // rate > 1: stretched first (tempo < 1), then resampled down. Otherwise resampled up, then squeezed.
  const lag = st.rate > 1 ? -(half * (1 - st.tempo) + seekLength / 2) : half * (1 - st.rate) - (st.rate * seekLength) / 2;
  return Math.round(lag);
}

/** Pure mono in / mono out (soundtouchjs works in stereo frames internally; we mirror the channel). */
export async function pitchShiftMono(input: Float32Array, semitones: number): Promise<Float32Array> {
  if (semitones === 0) return input;
  const st = new SoundTouch();
  st.tempo = 1.0;
  st.pitchSemitones = semitones;
  const lag = rawLagSamples(st);
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
  // Re-align onto the input's timeline: a late render loses its first `lag` raw samples, an early
  // one starts that far into the output (leaving the head silent).
  let skip = Math.max(0, lag);
  let written = Math.min(input.length, Math.max(0, -lag));
  let sinceYield = 0;
  for (;;) {
    const frames = filter.extract(chunk, CHUNK_FRAMES);
    if (frames <= 0) break;
    const from = Math.min(skip, frames);
    skip -= from;
    const take = Math.min(frames - from, input.length - written);
    for (let i = 0; i < take; i++) out[written + i] = chunk[(from + i) * 2]!;
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
