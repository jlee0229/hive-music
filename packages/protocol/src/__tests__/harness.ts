/**
 * Raw-socket test client for the mock server. Unlike the `Fake` in mock-server.test.ts it does NOT
 * throw on an unparsable frame: the hostile-client tests exist precisely to observe the server sending
 * something `parseServerMessage` refuses, so that has to be a recorded fact rather than a crash.
 */
import { parseServerMessage, type ClientMessage, type ServerMessage } from "../messages";

export const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

export class Raw {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  /** Frames that failed `parseServerMessage` — what a real phone silently drops. */
  unparsable: string[] = [];
  /** Size in bytes of the largest frame received. */
  maxFrameBytes = 0;
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const raw = String(ev.data);
      this.maxFrameBytes = Math.max(this.maxFrameBytes, raw.length);
      const m = parseServerMessage(raw);
      if (!m) {
        this.unparsable.push(raw);
        return;
      }
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    };
  }
  open() {
    return new Promise<void>((r) => (this.ws.readyState === 1 ? r() : (this.ws.onopen = () => r())));
  }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
  }
  /** Bypass the typed API: exactly the bytes a hostile client would put on the wire. */
  sendRaw(text: string) {
    this.ws.send(text);
  }
  forget() {
    this.inbox.length = 0;
    this.unparsable.length = 0;
  }
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 3000) {
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const p = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const hit = this.inbox.find(p);
      if (hit) return resolve(hit as Extract<ServerMessage, { type: T }>);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({ pred: p, resolve: (m) => { clearTimeout(t); resolve(m as Extract<ServerMessage, { type: T }>); } });
    });
  }
  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A port inside this checkout's mock block (HIVE_MOCK_PORT..+9); each test file takes its own offset. */
export const testPort = (offset: number) => Number(process.env.HIVE_MOCK_PORT ?? 8140) + offset;

/** Seeded PRNG (mulberry32) for property tests: a failure names its seed and replays exactly. */
export function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    bool: (p = 0.5) => next() < p,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
