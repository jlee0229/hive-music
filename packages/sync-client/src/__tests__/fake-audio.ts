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
  }
  stop(when = 0): void {
    this.stops.push(when);
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
  readonly outputLatency: number;
  state: "running" | "suspended" | "closed" = "suspended";
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
