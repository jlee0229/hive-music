/**
 * Runs in every simulated phone before any app code (context.addInitScript). It makes the Web Audio
 * engine observable from outside without touching application source:
 *
 *  - every AudioContext is recorded, and everything connected to its `destination` also feeds an
 *    AnalyserNode, so "is sound coming out" is an RMS of the real output, never UI text;
 *  - every AudioBufferSourceNode.start/stop and every playbackRate step is recorded, so the track
 *    position each phone is emitting can be reconstructed at any ctx time (the engine's rate trim is
 *    a setValueAtTime step, so the integral is exact);
 *  - a 20 Hz sampler keeps a ring of {wall clock, rms} for dead-air and time-to-sound measurements.
 *
 * Must stay self-contained: Playwright serialises this function, so it can close over nothing.
 */
export function instrumentPage(): void {
  type SourceRec = {
    id: number;
    ctx: number;
    buf: number;
    when: number;
    offset: number;
    dur: number;
    rate0: number;
    rates: Array<[number, number]>;
    stopAt: number;
    ended: boolean;
    calledAtCtx: number;
  };
  type Party = {
    ctxs: AudioContext[];
    analysers: AnalyserNode[];
    sources: SourceRec[];
    ring: Array<[number, number]>;
    seen: Record<string, number>;
    contextsCreated: number;
    startCalls: number;
    snap: () => unknown;
    ringSince: (wall: number) => Array<[number, number]>;
    clockProbe: (api: string) => Promise<{ offsetMs: number; rttMs: number } | null>;
  };
  const w = window as unknown as { __party?: Party };
  if (w.__party) return;
  const wall = () => performance.timeOrigin + performance.now();
  const P: Party = {
    ctxs: [],
    analysers: [],
    sources: [],
    ring: [],
    seen: {},
    contextsCreated: 0,
    startCalls: 0,
    snap: () => null,
    ringSince: () => [],
    clockProbe: async () => null,
  };
  w.__party = P;

  const Orig = window.AudioContext;
  if (!Orig) return;
  window.AudioContext = class extends Orig {
    constructor(options?: AudioContextOptions) {
      super(options);
      P.ctxs.push(this);
      P.contextsCreated++;
      const an = Orig.prototype.createAnalyser.call(this);
      an.fftSize = 2048;
      P.analysers.push(an);
    }
  };

  const origConnect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
  (AudioNode.prototype as unknown as { connect: unknown }).connect = function (this: AudioNode, ...args: unknown[]) {
    const i = P.ctxs.indexOf(this.context as AudioContext);
    if (i >= 0 && args[0] === this.context.destination) origConnect.call(this, P.analysers[i]);
    return origConnect.apply(this, args);
  };

  let nextId = 1;
  // Which AudioBuffer a source plays: a CHOIR phone swaps to a freshly rendered (pitched) one.
  const bufferIds = new WeakMap<AudioBuffer, number>();
  let nextBufferId = 1;
  const bufferId = (b: AudioBuffer | null): number => {
    if (!b) return 0;
    let id = bufferIds.get(b);
    if (!id) bufferIds.set(b, (id = nextBufferId++));
    return id;
  };
  const origStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when?: number, offset?: number, duration?: number) {
    const ctx = this.context as AudioContext;
    const rec: SourceRec = {
      id: nextId++,
      ctx: P.ctxs.indexOf(ctx),
      buf: bufferId(this.buffer),
      when: Math.max(when ?? 0, ctx.currentTime),
      offset: offset ?? 0,
      dur: this.buffer?.duration ?? 0,
      rate0: this.playbackRate.value,
      rates: [],
      stopAt: Infinity,
      ended: false,
      calledAtCtx: ctx.currentTime,
    };
    (this as unknown as { __rec: SourceRec }).__rec = rec;
    (this.playbackRate as unknown as { __rec: SourceRec }).__rec = rec;
    this.addEventListener("ended", () => {
      rec.ended = true;
    });
    P.startCalls++;
    P.sources.push(rec);
    // Keep the list bounded over a long soak: finished sources are history.
    if (P.sources.length > 400) P.sources = P.sources.filter((s) => !s.ended).slice(-300);
    if (duration === undefined) return origStart.call(this, when, offset);
    return origStart.call(this, when, offset, duration);
  };
  const origStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (this: AudioBufferSourceNode, when?: number) {
    const rec = (this as unknown as { __rec?: SourceRec }).__rec;
    if (rec) rec.stopAt = Math.min(rec.stopAt, Math.max(when ?? 0, (this.context as AudioContext).currentTime));
    return origStop.call(this, when);
  };
  const origSetValueAtTime = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function (this: AudioParam, value: number, time: number) {
    const rec = (this as unknown as { __rec?: SourceRec }).__rec;
    if (rec) rec.rates.push([time, value]);
    return origSetValueAtTime.call(this, value, time);
  };

  /** Track position (s) a source is emitting at ctx time `t`, or null when it is not sounding then. */
  const positionAt = (rec: SourceRec, t: number): number | null => {
    if (rec.ended || t < rec.when || t >= rec.stopAt) return null;
    let pos = rec.offset;
    let at = rec.when;
    let rate = rec.rate0;
    for (const [time, value] of rec.rates) {
      if (time >= t) break;
      if (time > at) {
        pos += (time - at) * rate;
        at = time;
      }
      rate = value;
    }
    pos += (t - at) * rate;
    return pos <= rec.dur ? pos : null;
  };

  const rmsOf = (an: AnalyserNode): number => {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
    return Math.sqrt(s / buf.length);
  };
  /** Strongest spectral component above 150 Hz (so a kick drum does not win), Hz; 0 when silent. */
  const peakHzOf = (an: AnalyserNode, sampleRate: number): number => {
    const bins = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(bins);
    const binHz = sampleRate / an.fftSize;
    let best = -Infinity;
    let at = 0;
    for (let i = Math.ceil(150 / binHz); i < bins.length; i++) {
      if (bins[i]! > best) {
        best = bins[i]!;
        at = i;
      }
    }
    return best > -70 ? Math.round(at * binHz) : 0;
  };
  const rmsNow = (): number => {
    let best = 0;
    for (let i = 0; i < P.ctxs.length; i++) if (P.ctxs[i]!.state === "running") best = Math.max(best, rmsOf(P.analysers[i]!));
    return best;
  };

  setInterval(() => {
    P.ring.push([wall(), rmsNow()]);
    if (P.ring.length > 6000) P.ring.splice(0, 1000);
  }, 50);

  // Strings that must never be on a screen during an ordinary flow, caught even if shown for a frame.
  const WATCH = ["Tap to resume", "Resuming", "Reconnecting", "Hive not found", "Removed from hive", "Loading the song", "Couldn't join"];
  document.addEventListener("DOMContentLoaded", () => {
    const check = () => {
      const text = document.body?.innerText ?? "";
      for (const s of WATCH) if (text.includes(s)) P.seen[s] = (P.seen[s] ?? 0) + 1;
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    check();
  });

  P.ringSince = (since: number) => P.ring.filter((r) => r[0] >= since);

  P.clockProbe = async (api: string) => {
    let best: { offsetMs: number; rttMs: number } | null = null;
    for (let i = 0; i < 6; i++) {
      try {
        const t0 = wall();
        const res = await fetch(`${api}/health`, { cache: "no-store" });
        const body = (await res.json()) as { serverTime: number };
        const t1 = wall();
        const rtt = t1 - t0;
        if (!best || rtt < best.rttMs) best = { offsetMs: body.serverTime - (t0 + t1) / 2, rttMs: rtt };
      } catch {
        /* the server is down: the caller sees null */
      }
    }
    return best;
  };

  P.snap = () => {
    const ctxs = P.ctxs.map((ctx, i) => {
      // Read the pair in one tick, exactly as the engine's own mapper does.
      const now = performance.now();
      const currentTime = ctx.currentTime;
      let out: { contextTime: number; performanceTime: number } | null = null;
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts.contextTime !== undefined && ts.performanceTime !== undefined) out = { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
      } catch {
        out = null;
      }
      const live: Array<{ id: number; buf: number; pos: number; posOut: number | null; when: number; offset: number; dur: number; rate: number }> = [];
      const seenKey = new Set<string>();
      for (const rec of P.sources) {
        if (rec.ctx !== i || rec.dur < 2) continue; // clicks and the unlock buffer are not music
        const pos = positionAt(rec, currentTime);
        if (pos === null) continue;
        const key = `${rec.when}:${rec.offset}`; // the stems of one branch share a start
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        live.push({
          id: rec.id,
          buf: rec.buf,
          pos,
          posOut: out ? positionAt(rec, out.contextTime) : null,
          when: rec.when,
          offset: rec.offset,
          dur: rec.dur,
          rate: rec.rates.length ? rec.rates[rec.rates.length - 1]![1] : rec.rate0,
        });
      }
      const pending = P.sources.filter((r) => r.ctx === i && r.dur >= 2 && !r.ended && r.when > currentTime && r.stopAt > r.when).length;
      return {
        state: ctx.state as string,
        currentTime,
        wallAtRead: performance.timeOrigin + now,
        sampleRate: ctx.sampleRate,
        outputLatencyMs: (ctx.outputLatency || 0) * 1000,
        baseLatencyMs: (ctx.baseLatency || 0) * 1000,
        out: out ? { contextTime: out.contextTime, wall: performance.timeOrigin + out.performanceTime } : null,
        live,
        pending,
        rms: ctx.state === "running" ? rmsOf(P.analysers[i]!) : 0,
        peakHz: ctx.state === "running" ? peakHzOf(P.analysers[i]!, ctx.sampleRate) : 0,
      };
    });
    const recent = P.ring.slice(-20);
    // The sampler is a 50 ms timer: a longer hole between two entries is the main thread being busy.
    let stallMs = 0;
    for (let k = Math.max(1, P.ring.length - 400); k < P.ring.length; k++) stallMs = Math.max(stallMs, P.ring[k]![0] - P.ring[k - 1]![0]);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      wall: wall(),
      ctxs,
      rms: rmsNow(),
      rmsMax1s: recent.reduce((m, r) => Math.max(m, r[1]), 0),
      stallMs20s: Math.round(stallMs),
      seen: { ...P.seen },
      contextsCreated: P.contextsCreated,
      startCalls: P.startCalls,
      visibility: document.visibilityState,
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 600),
      heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    };
  };
}
