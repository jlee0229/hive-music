/**
 * Offline pitch shifting for CHOIR: each phone re-renders its copy of the song at its assigned
 * pitch when the assignment arrives. SoundTouch (WSOLA time-stretch + transpose, via the
 * soundtouchjs port) keeps the duration identical, so the shared timeline is untouched — a
 * playbackRate shift would have changed speed and drifted the phone away from the room within
 * seconds. The render is chunked with event-loop yields so a 3-minute track doesn't freeze the UI.
 */
import { SimpleFilter, SoundTouch } from "soundtouchjs";

/**
 * Frames pulled from SoundTouch per call; also the size of SimpleFilter's internal input block,
 * so it is the finest slice there is. The render yields after every one: 0.37 s of audio costs
 * ~2 ms on a laptop and 10-20 ms on a mid-range phone. (It used to yield every 5 s of audio:
 * 25-44 ms measured on a laptop, a 0.2-0.4 s frozen main thread per slice on a phone.)
 */
const CHUNK_FRAMES = 16384;
/** Silence fed after the clip: two input blocks, more than everything SoundTouch can hold back. */
const TAIL_PAD_FRAMES = 2 * CHUNK_FRAMES;

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

export interface PitchShiftOptions {
  /** Polled between slices (an AbortSignal fits): an aborted render rejects instead of finishing. */
  signal?: { readonly aborted: boolean };
  /** Replaces the between-slice yield. Tests count it; a Worker would pass a no-op. */
  yieldToEventLoop?: () => Promise<void>;
  /**
   * Where to write the render (at least as long as the input). Pass an AudioBuffer's own channel and
   * the pitched copy exists exactly once; without it the render allocates its output, and copying that
   * into an AudioBuffer afterwards holds the whole song twice (44 MB each for four minutes at 48 kHz).
   */
  into?: Float32Array;
}

/** The mono value of sample `i`: the mean of the channels. */
function sampleAt(channels: readonly Float32Array[], i: number): number {
  let sum = 0;
  for (const ch of channels) sum += ch[i] ?? 0;
  return sum / channels.length;
}

/** Every this-many slices the yield is a real timer: 5.9 s of audio, the cadence it always had. */
const TIMER_HOP_EVERY = 16;

/**
 * The default yield: a MessageChannel macrotask, and a `setTimeout(0)` every 16th time.
 * Nested timers are clamped to 4 ms and throttled to one per second in a background tab, so
 * yielding ~650 times through timers alone would add 2.6 s of idle waiting to a 4-minute render
 * in the foreground and eleven minutes behind a hidden tab; a message hop costs microseconds.
 * The periodic timer is there because message tasks may be served ahead of due timers (Bun does
 * exactly that), and the engine's scheduler and watchdog live on timers.
 */
function macrotaskYielder(): { hop: () => Promise<void>; close: () => void } {
  const timerHop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  if (typeof MessageChannel === "undefined") return { hop: timerHop, close: () => {} };
  const channel = new MessageChannel();
  let wake: (() => void) | null = null;
  let hops = 0;
  channel.port1.onmessage = () => wake?.();
  return {
    hop: () =>
      ++hops % TIMER_HOP_EVERY === 0
        ? timerHop()
        : new Promise<void>((r) => {
            wake = r;
            channel.port2.postMessage(0);
          }),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/**
 * Mono out (soundtouchjs works in stereo frames internally; we mirror the channel). The input is one
 * channel, or several that are averaged sample by sample as they are read — a stereo original is
 * downmixed without a third copy of the song, instead of losing its right channel.
 */
export async function pitchShiftMono(
  source: Float32Array | readonly Float32Array[],
  semitones: number,
  opts: PitchShiftOptions = {},
): Promise<Float32Array> {
  const channels: readonly Float32Array[] = source instanceof Float32Array ? [source] : source;
  const input = channels[0] ?? new Float32Array(0);
  const mixed = channels.length > 1;
  // A non-finite shift is no shift: ±Infinity makes the stretcher's tempo 0 or Infinity and the
  // pull loop below then spins forever without yielding, freezing the tab.
  if (semitones === 0 || !Number.isFinite(semitones)) {
    if (!mixed && !opts.into) return input;
    const same = opts.into ?? new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) same[i] = sampleAt(channels, i);
    return same;
  }
  if (opts.into && opts.into.length < input.length) throw new RangeError("pitchShiftMono: `into` is shorter than the input");
  const st = new SoundTouch();
  st.tempo = 1.0;
  st.pitchSemitones = semitones;
  const lag = rawLagSamples(st);
  // SimpleFilter only processes whole 16384-frame input blocks and the stretcher holds back up to
  // a window more, so without a tail the last 0.24-0.44 s of every render came back as zeros (and a
  // clip under one block as pure silence). Zeros appended to the source flush the real ending out.
  const sourceFrames = input.length === 0 ? 0 : input.length + TAIL_PAD_FRAMES;
  const frameSource = {
    extract(target: Float32Array, numFrames: number, position: number): number {
      const frames = Math.min(numFrames, Math.max(0, sourceFrames - position));
      for (let i = 0; i < frames; i++) {
        const at = position + i;
        const s = at < input.length ? (mixed ? sampleAt(channels, at) : input[at]!) : 0;
        target[i * 2] = s;
        target[i * 2 + 1] = s;
      }
      return frames;
    },
  };
  const filter = new SimpleFilter(frameSource, st);

  // Output pinned to the input's length, so the timeline mapping never depends on the shifter.
  const out = opts.into ?? new Float32Array(input.length);
  // A supplied array may hold anything; an early render leaves its first `-lag` samples untouched.
  if (opts.into) out.fill(0, 0, input.length);
  const chunk = new Float32Array(CHUNK_FRAMES * 2);
  // Re-align onto the input's timeline: a late render loses its first `lag` raw samples, an early
  // one starts that far into the output (leaving the head silent).
  let skip = Math.max(0, lag);
  let written = Math.min(input.length, Math.max(0, -lag));
  const yielder = opts.yieldToEventLoop ? null : macrotaskYielder();
  const yieldToEventLoop = opts.yieldToEventLoop ?? yielder!.hop;
  try {
    for (;;) {
      const frames = filter.extract(chunk, CHUNK_FRAMES);
      if (frames <= 0) break;
      const from = Math.min(skip, frames);
      skip -= from;
      const take = Math.min(frames - from, input.length - written);
      for (let i = 0; i < take; i++) {
        // soundtouchjs's quick seek can pick overlap offset -1 at the start of its buffer and read
        // one frame before it: a NaN in the render. Hold the previous sample instead (v - v is 0
        // only for finite v).
        const v = chunk[(from + i) * 2]!;
        out[written + i] = v - v === 0 ? v : written + i > 0 ? out[written + i - 1]! : 0;
      }
      written += take;
      if (written >= input.length) break;
      await yieldToEventLoop();
      if (opts.signal?.aborted) throw new Error("pitch render aborted");
    }
  } finally {
    yielder?.close();
  }
  return out;
}
