/**
 * Virtual time for engine tests: replaces the global timer functions (and `performance.now`) with a
 * deterministic queue the test advances by hand. The engine's watchdog (2 s), drift check (1 s) and
 * pattern top-up (100 ms) are all `setInterval`s, so an hour of playback is an `advance(3_600_000)` and
 * takes milliseconds — and a test can assert that a timer is *gone*, which real timers cannot show.
 *
 * Always pair `install()` with `uninstall()` in a `finally`/`afterEach`: the patch is process-wide.
 */
type Fn = () => void;
interface Timer {
  id: number;
  at: number;
  fn: Fn;
  every: number | null;
}

export class VirtualTime {
  /** Virtual milliseconds since `install()`. */
  nowMs = 0;
  private timers = new Map<number, Timer>();
  private seq = 1;
  private saved: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    perfNow: () => number;
  } | null = null;

  install(): this {
    if (this.saved) return this;
    const g = globalThis as unknown as Record<string, unknown>;
    this.saved = {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      perfNow: performance.now.bind(performance),
    };
    const base = this.saved.perfNow();
    const add = (fn: Fn, ms: number | undefined, every: boolean): number => {
      const id = this.seq++;
      const delay = Math.max(0, Number(ms) || 0);
      this.timers.set(id, { id, at: this.nowMs + delay, fn, every: every ? Math.max(1, delay) : null });
      return id;
    };
    g.setInterval = (fn: Fn, ms?: number) => add(fn, ms, true);
    g.setTimeout = (fn: Fn, ms?: number) => add(fn, ms, false);
    g.clearInterval = (id?: number) => void this.timers.delete(id as number);
    g.clearTimeout = (id?: number) => void this.timers.delete(id as number);
    performance.now = () => base + this.nowMs;
    return this;
  }

  uninstall(): void {
    if (!this.saved) return;
    const g = globalThis as unknown as Record<string, unknown>;
    g.setInterval = this.saved.setInterval;
    g.clearInterval = this.saved.clearInterval;
    g.setTimeout = this.saved.setTimeout;
    g.clearTimeout = this.saved.clearTimeout;
    performance.now = this.saved.perfNow;
    this.saved = null;
    this.timers.clear();
  }

  /** Timers currently armed (intervals and timeouts). */
  get pending(): number {
    return this.timers.size;
  }
  get pendingIntervals(): number {
    return [...this.timers.values()].filter((t) => t.every !== null).length;
  }

  /** Moves time forward, firing every due timer in order at its own instant. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: Timer | null = null;
      for (const t of this.timers.values()) {
        if (t.at <= target && (next === null || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.nowMs = Math.max(this.nowMs, next.at);
      if (next.every !== null) next.at += next.every;
      else this.timers.delete(next.id);
      next.fn();
    }
    this.nowMs = target;
  }

  /**
   * Like `advance`, but yields to the microtask queue between steps so promise chains (a stem load, a
   * `resume()`) make progress while time moves.
   */
  async advanceAsync(ms: number, stepMs = 50): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.advance(step);
      left -= step;
      await flushMicrotasks();
    }
  }

  /** Jumps the clock without firing anything in between (a frozen page: timers do not catch up). */
  freeze(ms: number): void {
    this.nowMs += ms;
    for (const t of this.timers.values()) if (t.at < this.nowMs) t.at = this.nowMs;
  }
}

/** Lets already-resolved promise chains run to completion. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Deterministic PRNG (mulberry32) so a failing fuzz seed can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
