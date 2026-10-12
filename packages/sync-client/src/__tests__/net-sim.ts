/**
 * A network simulator for the clock model: drives `ClockModel.addProbe` with the same probe schedule the
 * engine uses (a burst of coded pairs, then one pair a second) over a link whose one-way delays the test
 * defines, against a "true" offset the test also defines — so the clock's error is known exactly at
 * every instant instead of being inferred.
 *
 * Time here is the phone's local clock, in ms. The true offset is `serverTime − localTime` and may drift
 * or step. Delivery is in order on each direction (this is one TCP connection: a delayed packet holds
 * back the ones behind it).
 */
import {
  NTP_BURST_COUNT, NTP_BURST_WINDOW_MS, NTP_PROBE_PAIR_GAP_MS, NTP_STEADY_INTERVAL_MS, RESYNC_THRESHOLD_MS,
} from "@hive/protocol";
import { ClockModel } from "../clock";

export interface Link {
  /** One-way delays for a packet sent at local time `t` (ms since the start of the run). */
  up(t: number): number;
  down(t: number): number;
}

export interface ClockSimOptions {
  durationMs: number;
  link: Link;
  /** serverTime − localTime at local time `t` (ms since start). */
  trueOffset: (t: number) => number;
  /** Windows `[from, to)` in which no probe is sent (a frozen tab, a dead socket). */
  gaps?: Array<[number, number]>;
  /** Local times at which the transport reconnects: `onReconnect()` and a fresh burst. */
  reconnectsAt?: number[];
  clock?: ClockModel;
}

export interface ClockSimResult {
  clock: ClockModel;
  /** (local time, applied-offset error in ms) after every delivered probe. */
  trace: Array<{ t: number; errMs: number }>;
  /** Local time of the first usable clock, ms; null if the clock never came up. */
  firstClockAtMs: number | null;
  /** Corrections larger than RESYNC_THRESHOLD_MS — each one is an audible hard resync on a playing phone. */
  steps: number;
  /** Error statistics over `[from, to)`. */
  stats(from: number, to?: number): { n: number; meanAbs: number; p95: number; max: number };
  /** First time after `from` at which |error| drops under `ms` and stays there for `holdMs`. */
  settledAt(from: number, ms: number, holdMs?: number): number | null;
}

const BASE = 1_700_000_000_000;

export function simulateClock(o: ClockSimOptions): ClockSimResult {
  const clock = o.clock ?? new ClockModel({ pairs: true });
  const inGap = (t: number): boolean => (o.gaps ?? []).some(([a, b]) => t >= a && t < b);

  // ---- the send schedule, as client.ts builds it -------------------------------------------------
  const sends: Array<{ t: number; id: number; index: 0 | 1 }> = [];
  let id = 0;
  const pair = (t: number): void => {
    if (t >= o.durationMs || inGap(t)) return;
    sends.push({ t, id, index: 0 }, { t: t + NTP_PROBE_PAIR_GAP_MS, id, index: 1 });
    id++;
  };
  const session = (from: number, until: number): void => {
    pair(from);
    const burstGap = NTP_BURST_WINDOW_MS / NTP_BURST_COUNT;
    for (let n = 1; n <= NTP_BURST_COUNT; n++) if (from + n * burstGap < until) pair(from + n * burstGap);
    for (let t = from + NTP_STEADY_INTERVAL_MS; t < until; t += NTP_STEADY_INTERVAL_MS) pair(t);
  };
  const starts = [0, ...(o.reconnectsAt ?? [])];
  starts.forEach((s, i) => session(s, starts[i + 1] ?? o.durationMs));
  sends.sort((a, b) => a.t - b.t);

  // ---- the wire: in-order delivery in each direction ----------------------------------------------
  let lastUpArrival = -Infinity;
  let lastDownArrival = -Infinity;
  const deliveries = sends.map((s) => {
    const serverRecvLocal = Math.max(lastUpArrival, s.t + Math.max(0, o.link.up(s.t)));
    lastUpArrival = serverRecvLocal;
    const clientRecv = Math.max(lastDownArrival, serverRecvLocal + Math.max(0, o.link.down(serverRecvLocal)));
    lastDownArrival = clientRecv;
    const t1 = BASE + serverRecvLocal + o.trueOffset(serverRecvLocal);
    return { ...s, t1, t3: clientRecv };
  });

  // ---- feed the clock in arrival order -------------------------------------------------------------
  const trace: Array<{ t: number; errMs: number }> = [];
  let firstClockAtMs: number | null = null;
  let steps = 0;
  let reconnectIdx = 0;
  const reconnects = [...(o.reconnectsAt ?? [])];
  for (const d of deliveries) {
    while (reconnectIdx < reconnects.length && reconnects[reconnectIdx]! <= d.t) {
      clock.onReconnect();
      reconnectIdx++;
    }
    if (d.t3 >= o.durationMs) continue;
    const before = clock.offsetMs;
    clock.addProbe(BASE + d.t, d.t1, d.t1, BASE + d.t3, d.id, d.index);
    if (clock.offsetMs === null) continue;
    firstClockAtMs ??= d.t3;
    if (before !== null && Math.abs(clock.offsetMs - before) > RESYNC_THRESHOLD_MS) steps++;
    trace.push({ t: d.t3, errMs: clock.offsetMs - o.trueOffset(d.t3) });
  }

  return {
    clock,
    trace,
    firstClockAtMs,
    steps,
    stats(from, to = Infinity) {
      const errs = trace.filter((p) => p.t >= from && p.t < to).map((p) => Math.abs(p.errMs)).sort((a, b) => a - b);
      if (errs.length === 0) return { n: 0, meanAbs: NaN, p95: NaN, max: NaN };
      return {
        n: errs.length,
        meanAbs: errs.reduce((a, b) => a + b, 0) / errs.length,
        p95: errs[Math.min(errs.length - 1, Math.floor(errs.length * 0.95))]!,
        max: errs[errs.length - 1]!,
      };
    },
    settledAt(from, ms, holdMs = 5000) {
      const pts = trace.filter((p) => p.t >= from);
      for (let i = 0; i < pts.length; i++) {
        if (Math.abs(pts[i]!.errMs) >= ms) continue;
        let ok = true;
        let covered = false;
        for (let j = i; j < pts.length; j++) {
          if (pts[j]!.t - pts[i]!.t > holdMs) {
            covered = true;
            break;
          }
          if (Math.abs(pts[j]!.errMs) >= ms) {
            ok = false;
            break;
          }
        }
        if (ok && (covered || i < pts.length)) return pts[i]!.t;
      }
      return null;
    },
  };
}

// ---- link models ----------------------------------------------------------------------------------
/** Symmetric link: each direction `base ± jitter` ms, independent per packet. */
export function iidLink(rand: () => number, baseMs: number, jitterMs: number): Link {
  const d = (): number => baseMs + (rand() * 2 - 1) * jitterMs;
  return { up: d, down: d };
}

/** Different mean delay in each direction — the case no round-trip measurement can see. */
export function asymmetricLink(rand: () => number, upMs: number, downMs: number, jitterMs: number): Link {
  return { up: () => upMs + (rand() * 2 - 1) * jitterMs, down: () => downMs + (rand() * 2 - 1) * jitterMs };
}

/**
 * A cellular-like link: a slowly wandering queue (correlated over ~1 s, so the two halves of a coded
 * pair usually see the same delay) plus a little per-packet noise, independently per direction.
 */
export function wanderingLink(rand: () => number, baseMs: number, swingMs: number, noiseMs: number, corrMs = 1000): Link {
  const dir = () => {
    let phase = rand() * 1000;
    let level = rand();
    let lastT = 0;
    return (t: number): number => {
      const dt = Math.max(0, t - lastT);
      lastT = t;
      const a = Math.exp(-dt / corrMs);
      level = level * a + rand() * (1 - a);
      phase += dt;
      return baseMs + (level * 2 - 1) * swingMs + (rand() * 2 - 1) * noiseMs;
    };
  };
  return { up: dir(), down: dir() };
}

/** A quiet link that every `everyMs` suffers `burstMs` of heavy queueing in one direction or both. */
export function burstyLink(
  rand: () => number,
  quiet: Link,
  everyMs: number,
  burstMs: number,
  extraMs: number,
  where: "up" | "down" | "both" = "both",
): Link {
  const inBurst = (t: number): boolean => t % everyMs >= everyMs - burstMs;
  const extra = (): number => extraMs * (0.5 + rand());
  return {
    up: (t) => quiet.up(t) + (inBurst(t) && where !== "down" ? extra() : 0),
    down: (t) => quiet.down(t) + (inBurst(t) && where !== "up" ? extra() : 0),
  };
}
