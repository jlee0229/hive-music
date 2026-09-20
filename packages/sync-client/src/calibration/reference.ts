/**
 * `calibration.runAsReference()` — the host phone listens while every player clicks in turn, and reports
 * how late each one really is relative to the others (docs/04-calibration.md).
 *
 * Three things here are not obvious and matter:
 *
 * 1. **The microphone opens inside the tap, before the countdown.** iOS only grants `getUserMedia` from a
 *    user gesture, and the countdown is 3 s of `await`. So this function opens the mic first and *then*
 *    waits for `CALIBRATION_PLAN`, rather than waiting for the plan and opening the mic when it arrives.
 * 2. **The capture is timestamped from inside the audio graph, not from `Date` or a timer.** The worklet
 *    reports the `currentTime` of its first processed frame; that maps to a server time through the same
 *    `CtxMapper` the scheduler uses. Only the ±150 ms window placement depends on it, so a few ms of
 *    error there is harmless — but a *timer*-based estimate could be off by 100 ms and lose a click.
 * 3. **The worklet is loaded from a Blob URL.** The frontend owns the build and this package must not
 *    require a bundler entry for a worklet file, so the processor source is a string compiled at runtime.
 *    `ScriptProcessorNode` is the fallback for anything that refuses.
 *
 * Never call this on a phone that is playing: `getUserMedia` switches iOS into play-and-record, which
 * changes both volume and output latency. The server keeps the reference out of the click order for the
 * same reason.
 */
import {
  DEFAULT_CLICK_SPEC, type ClickSpec, type ServerMessage,
} from "@hive/protocol";
import type { CalibrationMeasurement, CalibrationProgress, CalibrationResult } from "../index";
import type { CtxMapper } from "../clock";
import { renderClick } from "./click";
import { analyzeClicks, DEFAULT_MIN_CONFIDENCE } from "./xcorr";

export type CalibrationPlan = Extract<ServerMessage, { type: "CALIBRATION_PLAN" }>;

/**
 * Thrown by `runAsReference()` when the host cancels (`CALIBRATION_CANCEL`) or the server otherwise
 * returns the room to idle mid-run. Distinguishable by `name` so a UI can ignore it rather than show
 * "calibration failed" for something the user asked for.
 */
export class CalibrationCancelledError extends Error {
  readonly name = "CalibrationCancelledError";
  constructor(message = "calibration was cancelled") {
    super(message);
  }
}

/** Lets the engine abort a run in progress; `runAsReference` polls it on every step. */
export interface CancelSignal {
  readonly cancelled: boolean;
}

/** Tail recorded after the last click, ms, so a late phone is still inside the recording. */
export const RECORD_TAIL_MS = 400;
/** Recording starts this far before the first click, ms, so an early phone is too. */
export const RECORD_LEAD_MS = 200;
/** How long to wait for CALIBRATION_PLAN after asking the server to start. */
export const PLAN_TIMEOUT_MS = 10_000;

export interface ReferenceDeps {
  ctx: AudioContext;
  mapper: CtxMapper;
  /** Estimated server time now. */
  serverNow: () => number;
  /** Resolves with the plan the server sends to the reference. */
  awaitPlan: (timeoutMs: number) => Promise<CalibrationPlan>;
  report: (measurements: CalibrationMeasurement[]) => void;
  /** Flips to cancelled when the room goes idle; checked at every await point. */
  signal?: CancelSignal;
}

interface Capture {
  chunks: Float32Array[];
  frames: number;
  firstFrameCtxTime: number | null;
  stop: () => void;
}

const WORKLET_SOURCE = `
// Captures every input frame and posts it to the main thread with the ctx time of the first frame.
class HiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.started = false; }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      if (!this.started) { this.started = true; this.port.postMessage({ firstFrameCtxTime: currentTime }); }
      // A copy: the render thread reuses these buffers.
      this.port.postMessage({ samples: new Float32Array(input[0]) });
    }
    return true;
  }
}
registerProcessor('hive-capture', HiveCaptureProcessor);
`;

async function startCapture(ctx: AudioContext, source: MediaStreamAudioSourceNode): Promise<Capture> {
  const capture: Capture = { chunks: [], frames: 0, firstFrameCtxTime: null, stop: () => {} };

  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, "hive-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { samples?: Float32Array; firstFrameCtxTime?: number };
      if (typeof data.firstFrameCtxTime === "number" && capture.firstFrameCtxTime === null) {
        capture.firstFrameCtxTime = data.firstFrameCtxTime;
      }
      if (data.samples) {
        capture.chunks.push(data.samples);
        capture.frames += data.samples.length;
      }
    };
    source.connect(node);
    capture.stop = () => {
      node.port.onmessage = null;
      try {
        source.disconnect(node);
      } catch {
        /* already gone */
      }
      node.disconnect();
    };
    return capture;
  } catch {
    // ScriptProcessorNode: deprecated, runs on the main thread, and still the only thing that works
    // everywhere. Its callback carries `playbackTime` on some engines; ctx.currentTime is close enough
    // for window placement.
    const size = 4096;
    const node = ctx.createScriptProcessor(size, 1, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    node.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (capture.firstFrameCtxTime === null) capture.firstFrameCtxTime = ctx.currentTime - size / ctx.sampleRate;
      const input = ev.inputBuffer.getChannelData(0);
      capture.chunks.push(new Float32Array(input));
      capture.frames += input.length;
    };
    source.connect(node);
    // A ScriptProcessor only runs when connected to the destination; route it through a muted gain.
    node.connect(silent);
    silent.connect(ctx.destination);
    capture.stop = () => {
      node.onaudioprocess = null;
      try {
        source.disconnect(node);
      } catch {
        /* already gone */
      }
      node.disconnect();
      silent.disconnect();
    };
    return capture;
  }
}

function flatten(chunks: Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export async function runAsReference(
  deps: ReferenceDeps,
  opts: { onProgress?: (p: CalibrationProgress) => void } = {},
): Promise<CalibrationResult> {
  const { ctx, mapper } = deps;
  const progress = (p: CalibrationProgress) => opts.onProgress?.(p);
  /*
   * Cancellation is checked, never trusted to unwinding: the mic is the resource that matters, and on
   * iOS an un-released input track keeps the audio session in play-and-record, which changes output
   * latency for every phone afterwards. So every exit path runs through the same `finally`, and this
   * helper is called at each await boundary rather than only at the top.
   */
  const abortIfCancelled = () => {
    if (deps.signal?.cancelled) throw new CalibrationCancelledError();
  };
  abortIfCancelled();

  // 1 · the microphone, inside the gesture. Every processing feature off: echo cancellation would
  // actively remove the clicks, and AGC would change gain mid-recording.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
      video: false,
    });
  } catch (err) {
    progress({ phase: "failed", currentClientId: null, done: 0, total: 0 });
    throw new Error(`microphone denied: ${err instanceof Error ? err.message : String(err)}`);
  }

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  let capture: Capture | null = null;
  try {
    const source = ctx.createMediaStreamSource(stream);
    capture = await startCapture(ctx, source);

    // 2 · the plan. The server sends it to the reference only.
    progress({ phase: "countdown", currentClientId: null, done: 0, total: 0 });
    const plan = await deps.awaitPlan(PLAN_TIMEOUT_MS);
    abortIfCancelled();
    const spec: ClickSpec = plan.clickSpec ?? DEFAULT_CLICK_SPEC;
    const total = plan.order.length;

    // 3 · record through the whole window. Progress is reported from the shared clock, so the UI's
    // "listening to phone 3 of 6" matches the phone that is actually clicking.
    const endServerTime = plan.startServerTime + total * plan.intervalMs + RECORD_TAIL_MS;
    progress({ phase: "listening", currentClientId: plan.order[0] ?? null, done: 0, total });
    while (deps.serverNow() < endServerTime) {
      const elapsed = deps.serverNow() - plan.startServerTime;
      const k = Math.floor(elapsed / plan.intervalMs);
      if (k >= 0 && k < total) {
        progress({ phase: "listening", currentClientId: plan.order[k] ?? null, done: Math.max(0, k), total });
      }
      await sleep(Math.min(100, endServerTime - deps.serverNow()));
      abortIfCancelled(); // a cancel mid-recording stops here; the finally releases the mic
    }

    // 4 · analyse. The recording's own start time comes from the audio graph, through the same mapping
    // the scheduler uses.
    abortIfCancelled();
    progress({ phase: "analysing", currentClientId: null, done: total, total });
    const recording = flatten(capture.chunks, capture.frames);
    const recordingSec = recording.length / ctx.sampleRate;
    // The ctx time of the first frame the graph handed us. If the worklet never reported one (the
    // ScriptProcessor path sets it too), fall back to "now minus the recording length", which is the
    // same quantity measured less precisely — and only the window placement depends on it.
    const firstFrameCtxTime = capture.firstFrameCtxTime ?? ctx.currentTime - recordingSec;
    capture.stop();
    capture = null;

    const recordingStartServerTime =
      mapper.serverTimeForCtx(firstFrameCtxTime) ?? deps.serverNow() - recordingSec * 1000;

    const template = renderClick(spec, ctx.sampleRate);
    const analysis = analyzeClicks({
      recording,
      sampleRate: ctx.sampleRate,
      template,
      expectedMs: plan.order.map((_, k) => plan.startServerTime + k * plan.intervalMs - recordingStartServerTime),
    });

    const measurements: CalibrationMeasurement[] = analysis.clicks.map((c, i) => ({
      clientId: plan.order[i]!,
      residualMs: c.residualMs,
      confidence: c.confidence,
    }));

    // 5 · report, then let the microphone go. On iOS a live input track keeps the audio session in
    // play-and-record, which changes output latency for everything afterwards.
    abortIfCancelled(); // never write offsets for a run someone abandoned
    deps.report(measurements);
    release();
    progress({ phase: "done", currentClientId: null, done: total, total });

    return {
      measurements,
      diagnostics: {
        sampleRate: ctx.sampleRate,
        recordingSec,
        recordingStartServerTime,
        medianRawMs: analysis.medianRawMs,
        anchorCount: analysis.anchorCount,
        minConfidence: DEFAULT_MIN_CONFIDENCE,
        clicks: analysis.clicks,
        order: plan.order,
        plan: { startServerTime: plan.startServerTime, intervalMs: plan.intervalMs },
      },
    };
  } catch (err) {
    // A cancel is not a failure; the UI should not say calibration broke.
    if (!(err instanceof CalibrationCancelledError)) {
      progress({ phase: "failed", currentClientId: null, done: 0, total: 0 });
    }
    throw err;
  } finally {
    capture?.stop();
    release();
  }
}
