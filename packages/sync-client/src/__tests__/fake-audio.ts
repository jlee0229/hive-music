/**
 * A fake AudioContext for headless tests. It records what was scheduled instead of making sound, which
 * is the only way to assert the scheduling arithmetic — the thing that actually determines whether two
 * phones are within 10 ms — without a browser.
 *
 * `currentTime` advances from an injected clock, so a test can either freeze time or let it run.
 */
import type { BufferLike, CtxLike, GainLike, ParamLike, SourceLike } from "../scheduler";

export interface ParamEvent {
  kind: "setValueAtTime" | "linearRamp" | "setTarget" | "setValueCurve" | "cancel";
  value?: number;
  time: number;
  timeConstant?: number;
  curve?: Float32Array;
  duration?: number;
}

export class FakeParam implements ParamLike {
  value = 1;
  events: ParamEvent[] = [];
  /**
   * Opt-in honesty about the one Web Audio rule the scheduler can trip over: `setValueCurveAtTime` throws
   * NotSupportedError when the new curve overlaps one that is already scheduled. The scheduler swallows
   * that throw, so without this a test cannot see a pattern window silently going missing.
   */
  static strictCurves = false;
  /** Curves refused for overlap while `strictCurves` was on. */
  curveRejections = 0;
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "setValueAtTime", value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "linearRamp", value, time });
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): void {
    this.value = value;
    this.events.push({ kind: "setTarget", value, time, timeConstant });
  }
  setValueCurveAtTime(curve: Float32Array, time: number, duration: number): void {
    if (FakeParam.strictCurves) {
      // Events removed by a later cancelScheduledValues no longer count.
      let live: ParamEvent[] = [];
      for (const e of this.events) {
        if (e.kind === "cancel") live = live.filter((x) => (x.kind === "setValueCurve" ? x.time + x.duration! < e.time : x.time < e.time));
        else live.push(e);
      }
      const end = time + duration;
      const overlaps = live.some((e) =>
        e.kind === "setValueCurve" ? time < e.time + e.duration! && e.time < end : e.time > time && e.time < end,
      );
      if (overlaps) {
        this.curveRejections++;
        throw new Error("NotSupportedError: setValueCurveAtTime overlaps an existing automation event");
      }
    }
    this.events.push({ kind: "setValueCurve", time, curve, duration });
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ kind: "cancel", time });
  }
}

export class FakeGain implements GainLike {
  readonly gain = new FakeParam();
  connections: unknown[] = [];
  connect(dest: never): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections = [];
  }
}

export interface StartCall {
  when: number;
  offset: number;
}

export class FakeSource implements SourceLike {
  buffer: BufferLike | null = null;
  /** B9e: the rate trim lands here. A step per drift tick, so `events` is the correction history. */
  readonly playbackRate = new FakeParam();
  starts: StartCall[] = [];
  stops: number[] = [];
  /** `ctx.currentTime` when `start()` was called, so a test can prove nothing was scheduled in the past. */
  startCalledAtCtx: number[] = [];
  ctxNow: () => number = () => 0;
  onended: ((ev: never) => unknown) | null = null;
  connections: unknown[] = [];
  connect(dest: never): unknown {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections = [];
  }
  start(when = 0, offset = 0): void {
    this.starts.push({ when, offset });
    this.startCalledAtCtx.push(this.ctxNow());
  }
  stop(when = 0): void {
    this.stops.push(when);
  }
  /** When this source stops making sound: the earliest stop(), or the end of its buffer. */
  get endsAt(): number {
    const s = this.starts[0];
    if (!s) return -Infinity;
    const natural = s.when + Math.max(0, (this.buffer?.duration ?? 0) - s.offset);
    return Math.min(natural, ...this.stops);
  }
  /** True while this source would be producing samples at ctx time `t`. */
  liveAt(t: number): boolean {
    const s = this.starts[0];
    return !!s && s.when <= t && t < this.endsAt;
  }
  /** Track position this source is playing at ctx time `t` (nominal rate). */
  positionAt(t: number): number {
    const s = this.starts[0]!;
    return s.offset + (t - s.when);
  }
  /**
   * Track position actually sounding at ctx time `t`, integrating every `playbackRate` step the scheduler
   * wrote. This is the ground truth the scheduler itself cannot read back from Web Audio — it has to keep
   * its own books (`slewSec`) — so a test that uses it catches the books being wrong.
   */
  contentPositionAt(t: number): number {
    const s = this.starts[0]!;
    const steps = this.playbackRate.events
      .filter((e) => e.kind === "setValueAtTime")
      .map((e) => ({ time: e.time, rate: e.value! }))
      .sort((a, b) => a.time - b.time);
    let pos = s.offset;
    let at = s.when;
    let rate = 1;
    for (const step of steps) {
      if (step.time >= t) break;
      const from = Math.max(at, step.time);
      if (from > at) pos += (from - at) * rate;
      at = Math.max(at, from);
      rate = step.rate;
    }
    if (t > at) pos += (t - at) * rate;
    return pos;
  }
}

export class FakeBuffer implements BufferLike {
  constructor(
    readonly duration: number,
    readonly sampleRate = 44100,
  ) {}
  get length(): number {
    return Math.round(this.duration * this.sampleRate);
  }
  private data = new Map<number, Float32Array>();
  getChannelData(ch: number): Float32Array {
    if (!this.data.has(ch)) this.data.set(ch, new Float32Array(this.length));
    return this.data.get(ch)!;
  }
  copyToChannel(source: Float32Array, ch: number): void {
    this.getChannelData(ch).set(source.subarray(0, this.length));
  }
  numberOfChannels = 1;
}

export interface FakeCtxOptions {
  /** Where `currentTime` starts, seconds. */
  startTime?: number;
  sampleRate?: number;
  outputLatency?: number;
  /** Return ctx seconds; default is a frozen clock at `startTime`. */
  clock?: () => number;
}

export class FakeAudioContext implements CtxLike {
  readonly sampleRate: number;
  readonly destination = { connect: () => undefined, disconnect: () => undefined };
  outputLatency: number;
  state: "running" | "suspended" | "closed" | "interrupted" = "suspended";
  onstatechange: (() => void) | null = null;
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  private readonly clockFn: () => number;
  /** Manual time control: added to the clock's value. */
  advanceBy = 0;

  constructor(private readonly opts: FakeCtxOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 44100;
    this.outputLatency = opts.outputLatency ?? 0;
    const start = opts.startTime ?? 0;
    this.clockFn = opts.clock ?? (() => start);
  }

  get currentTime(): number {
    return this.clockFn() + this.advanceBy;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    s.ctxNow = () => this.currentTime;
    this.sources.push(s);
    return s;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(length / sampleRate, sampleRate);
  }
  async resume(): Promise<void> {
    this.state = "running";
    this.onstatechange?.();
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  /** Every `source.start()` across the whole context, oldest first. */
  allStarts(): StartCall[] {
    return this.sources.flatMap((s) => s.starts);
  }
}
