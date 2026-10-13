/**
 * A whole audio engine on virtual time: `createBrowserAudioEngine` wired to fake AudioContexts whose
 * `currentTime` follows a `VirtualTime`, a clock model with a known offset, and stem loads the test
 * resolves by hand. Everything the engine does on a timer (watchdog, drift check, pattern top-up, load
 * retry) can then be driven for simulated hours and inspected.
 */
import type { Assignment, RoomState, Transport } from "@hive/protocol";
import { createBrowserAudioEngine, type BrowserAudioEngineOptions, type FetchStemOptions } from "../audio";
import type { AudioEngine, AudioEngineContext } from "../client";
import { ClockModel, CtxMapper } from "../clock";
import { Emitter } from "../transport";
import { FakeAudioContext, FakeBuffer, type FakeSource } from "./fake-audio";
import type { VirtualTime } from "./sim";

export const LOCAL0 = 1_700_000_000_000;
export const STEMS = ["drums", "bass", "vocals", "other"];

/** A fake context on virtual time that can be frozen (the iOS zombie) or made to hang on resume(). */
export class SimCtx extends FakeAudioContext {
  frozen = false;
  /** When true, resume() returns a promise that never settles (seen on iOS while interrupted). */
  hangResume = false;
  resumeCalls = 0;
  closeCalls = 0;
  private frozenAt = 0;
  private lost = 0;
  constructor(
    private readonly vt: VirtualTime,
    private readonly base: number,
    outputLatency = 0,
  ) {
    super({ outputLatency });
  }
  private get raw(): number {
    return this.base + this.vt.nowMs / 1000 - this.lost;
  }
  override get currentTime(): number {
    return this.frozen ? this.frozenAt : this.raw;
  }
  freeze(): void {
    this.frozenAt = this.raw;
    this.frozen = true;
  }
  thaw(): void {
    if (!this.frozen) return;
    this.lost += this.raw - this.frozenAt;
    this.frozen = false;
  }
  override async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.hangResume) return new Promise<void>(() => {});
    if (this.state === "closed") throw new Error("InvalidStateError: context is closed");
    if (this.state === "running") return; // a browser fires statechange only when the state changes
    this.state = "running";
    this.onstatechange?.();
  }
  override async close(): Promise<void> {
    this.closeCalls++;
    this.freeze();
    this.state = "closed";
  }
  /** Sources producing sound at ctx time `t`, per stem index within its branch. */
  liveSources(t = this.currentTime): FakeSource[] {
    return this.sources.filter((s) => s.liveAt(t));
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: Error): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const makeAssignment = (over: Partial<Assignment> = {}): Assignment => ({
  label: "unison",
  role: "unison",
  color: "#F8FAFC",
  gainsDb: Object.fromEntries(STEMS.map((s) => [s, 0])),
  delayMs: 0,
  compensationMs: 0,
  pattern: null,
  applyAtServerTime: null,
  ...over,
});

export interface EngineRigOptions {
  /** Called for every stem fetch; default resolves at once with a 60 s buffer. */
  loadStem?: (url: string) => Promise<unknown>;
  durationSec?: number;
  outputLatency?: number;
  tableLatencyMs?: number | null;
  pitchKeepIdleBytes?: number;
  /**
   * Switches the rig to the engine's real two-phase load (bytes, then decode), which is what makes the
   * pre-download of the next song possible. The test decides when each file's bytes arrive.
   */
  fetchStem?: (url: string, o: FetchStemOptions) => Promise<ArrayBuffer>;
  /** With `fetchStem`: how long a decode takes on virtual time (default: none). */
  decodeMs?: number;
}

export function engineRig(vt: VirtualTime, opts: EngineRigOptions = {}) {
  const localMs = (): number => LOCAL0 + vt.nowMs;
  const clock = new ClockModel();
  clock.addProbe(LOCAL0, LOCAL0, LOCAL0, LOCAL0); // offset 0: server time == local time
  const mapper = new CtxMapper(clock);
  const emit = new Emitter();
  const sent: Array<{ type: string } & Record<string, unknown>> = [];
  const audioEvents: Array<{ state: string; progress: number }> = [];
  const errors: Array<{ code: string; message: string }> = [];
  emit.on("audio", (state, progress) => audioEvents.push({ state, progress }));
  emit.on("error", (code, message) => errors.push({ code, message }));
  const contexts: SimCtx[] = [];
  const durationSec = opts.durationSec ?? 60;

  const track = (id: string, stems: string[] = STEMS): NonNullable<RoomState["track"]> => ({
    id,
    title: id,
    durationSec,
    stems,
    bpm: 120,
  });

  const makeRoom = (over: {
    transport?: Transport;
    trackId?: string | null;
    assignment?: Assignment | null;
    tableLatencyMs?: number | null;
    calibratedOffsetMs?: number | null;
    audioReadyTrackId?: string | null;
    stems?: string[];
    /** The server's hint for the song after this one (id), or null/undefined for none. */
    nextTrackId?: string | null;
    nextStems?: string[];
  } = {}): { room: RoomState; assignment: Assignment | null } => {
    const assignment = over.assignment === undefined ? makeAssignment() : over.assignment;
    const trackId = over.trackId === undefined ? "song-a" : over.trackId;
    const room: RoomState = {
      code: "TEST",
      protocolVersion: 1,
      createdAtServerTime: LOCAL0,
      hostClientIds: [],
      track: trackId ? track(trackId, over.stems) : null,
      ...(over.nextTrackId === undefined ? {} : { nextTrack: over.nextTrackId ? track(over.nextTrackId, over.nextStems) : null }),
      transport: over.transport ?? { state: "stopped" },
      mode: { kind: "UNISON", params: {} },
      scenePlan: null,
      calibration: { state: "idle", referenceClientId: null, startServerTime: null, order: [], results: {} },
      clients: {
        me: {
          id: "me",
          kind: "player",
          plays: true,
          name: "Me",
          device: { userAgent: "test", platform: "test", browserFamily: "android-chrome" },
          joinIndex: 0,
          joinedAtServerTime: LOCAL0,
          position: null,
          pinnedRole: null,
          nudgeMs: 0,
          tableLatencyMs: over.tableLatencyMs === undefined ? (opts.tableLatencyMs ?? 0) : over.tableLatencyMs,
          calibratedOffsetMs: over.calibratedOffsetMs ?? null,
          assignment,
          connected: true,
          audioReadyTrackId: over.audioReadyTrackId === undefined ? trackId : over.audioReadyTrackId,
        },
      },
    };
    return { room, assignment };
  };

  const host: AudioEngineContext = {
    opts: { wsUrl: "ws://x/ws", apiUrl: "http://x", roomCode: "TEST", kind: "player", plays: true, clientId: "me" },
    clock,
    mapper,
    emit,
    send: (m) => sent.push(m as never),
    clientId: "me",
    room: () => null,
    now: localMs,
  };

  const loadCalls: string[] = [];
  /** `pitchYields`: slices the CHOIR render has finished — the only outside sign that one is running. */
  const counters = { pitchYields: 0 };
  const fetchCalls: Array<{ url: string; priority: string | undefined; signal: AbortSignal | undefined }> = [];
  const decodeCalls: number[] = [];
  const twoPhase: Partial<BrowserAudioEngineOptions> = opts.fetchStem
    ? {
        fetchStem: (url, o) => {
          fetchCalls.push({ url, priority: o.priority, signal: o.signal });
          return opts.fetchStem!(url, o);
        },
        decodeStem: (async (bytes: ArrayBuffer) => {
          decodeCalls.push(vt.nowMs);
          if (opts.decodeMs) await new Promise((resolve) => setTimeout(resolve, opts.decodeMs));
          void bytes;
          return new FakeBuffer(durationSec, 44100);
        }) as unknown as BrowserAudioEngineOptions["decodeStem"],
      }
    : {
        loadStem: (async (url: string) => {
          loadCalls.push(url);
          if (opts.loadStem) return opts.loadStem(url);
          return new FakeBuffer(durationSec, 44100);
        }) as unknown as (url: string, c: AudioContext) => Promise<AudioBuffer>,
      };
  const engine = createBrowserAudioEngine(host, {
    createContext: () => {
      const c = new SimCtx(vt, 10 + contexts.length * 1000, opts.outputLatency ?? 0);
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    ...twoPhase,
    // The CHOIR render yields through a timer, so it advances exactly as far as the test moves time.
    pitchKeepIdleBytes: opts.pitchKeepIdleBytes,
    pitchYield: () => {
      counters.pitchYields++;
      return new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  }) as AudioEngine & { debug: AudioEngine["debug"] & Record<string, unknown> };

  return {
    engine,
    clock,
    mapper,
    emit,
    sent,
    audioEvents,
    errors,
    contexts,
    loadCalls,
    fetchCalls,
    decodeCalls,
    counters,
    localMs,
    makeRoom,
    /** The most recently created context. */
    get ctx(): SimCtx {
      return contexts[contexts.length - 1]!;
    },
    apply(over: Parameters<typeof makeRoom>[0] = {}): { room: RoomState; assignment: Assignment | null } {
      const r = makeRoom(over);
      engine.applyRoom(r.room, r.assignment);
      return r;
    },
    playingAt(serverTimeAtTrackZero: number): Transport {
      return { state: "playing", serverTimeAtTrackZero };
    },
  };
}
