/**
 * Clock sync against simulated networks (audit scale-net).
 *
 * `clock.test.ts` proves the estimator's arithmetic on hand-built probes. This file asks the question a
 * party asks: on *this kind of link*, how wrong is a phone's idea of server time, how long until it is
 * usable, and how far apart are two phones that sit on different links?
 *
 * The simulator is deliberately small and fully seeded:
 *  - one-way delay = a hard floor (propagation) + a random queueing tail, separately per direction;
 *  - the socket is TCP, so nothing is lost and nothing is reordered: a "lost" segment is a retransmit
 *    timeout, and everything behind it in that direction waits (head-of-line blocking);
 *  - a stall holds both directions for its whole length;
 *  - the phone's crystal drifts against the server (ppm), so an old sample is a stale sample;
 *  - probes leave on the engine's real schedule (client.ts `startTimers`): one pair at once, 20 pairs
 *    200 ms apart, and one pair per second, the two halves 10 ms apart — including the detail that a
 *    burst tick and a steady tick landing together cancel the first one's second half.
 *
 * Every number asserted below is a *characterisation* of the estimator as it is today, with headroom;
 * the `test.failing` cases are the measured gaps, written as the behaviour we want (flip to `test` when
 * engine-sync lands the change). Set NET_REPORT=<path> to write the full table as JSON + text.
 */
import { describe, expect, test } from "bun:test";
import {
  NTP_BURST_COUNT, NTP_BURST_WINDOW_MS, NTP_PROBE_PAIR_GAP_MS, NTP_SAMPLE_MAX_AGE_MS, NTP_STEADY_INTERVAL_MS,
  RESYNC_THRESHOLD_MS, SYNC_FLOOR_MS, SYNC_TARGET_MS,
} from "@hive/protocol";
import { ClockModel, SLEW_RATE_MS_PER_SEC } from "../clock";

// ---- seeded randomness ----------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const expo = (rand: () => number, mean: number) => -mean * Math.log(1 - rand());
/** Lognormal with the given mean and standard deviation: a long right tail, like a busy AP's queue. */
function lognormal(rand: () => number, mean: number, sd: number): number {
  const sigma2 = Math.log(1 + (sd * sd) / (mean * mean));
  const mu = Math.log(mean) - sigma2 / 2;
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return Math.exp(mu + Math.sqrt(sigma2) * z);
}

// ---- links ----------------------------------------------------------------------------------------------
interface Link {
  name: string;
  /** Queueing + propagation for one segment sent at `t` (ms since the socket opened). */
  up(t: number, rand: () => number): number;
  down(t: number, rand: () => number): number;
  /** Probability a segment needs a retransmit; it then arrives one RTO late. */
  loss?: number;
  rtoMs?: number;
  /** Mean gap between full stalls, and their length. */
  stallEveryMs?: number;
  stallMs?: number;
  /** (floorUp - floorDown) / 2 at time t: the bias no NTP-style exchange can see. */
  floorBias(t: number): number;
}

const LINKS: Record<string, Link> = {
  // RTT 2 ± 1 ms
  lan: { name: "LAN 2±1 ms", up: (_t, r) => 0.5 + expo(r, 0.5), down: (_t, r) => 0.5 + expo(r, 0.5), floorBias: () => 0 },
  // RTT 15 ± 10 ms
  homeWifi: { name: "home Wi-Fi 15±10 ms", up: (_t, r) => 2.5 + expo(r, 5), down: (_t, r) => 2.5 + expo(r, 5), floorBias: () => 0 },
  // RTT 60 ± 80 ms, 2 % loss, a 500 ms stall every ~20 s
  venueWifi: {
    name: "venue Wi-Fi 60±80 ms, 2% loss, 500 ms stalls",
    up: (_t, r) => 8 + lognormal(r, 22, 40),
    down: (_t, r) => 8 + lognormal(r, 22, 40),
    loss: 0.02,
    rtoMs: 250,
    stallEveryMs: 20_000,
    stallMs: 500,
    floorBias: () => 0,
  },
  // RTT 70 ± 30 ms, uplink slower than downlink (scheduling grants): floors 30 up / 15 down
  lte: { name: "LTE 70±30 ms, asymmetric", up: (_t, r) => 30 + expo(r, 15), down: (_t, r) => 15 + expo(r, 10), loss: 0.005, rtoMs: 300, floorBias: () => 7.5 },
  // A phone hotspot whose path gets 90 ms longer, symmetrically, 90 s into the song
  hotspotStep: {
    name: "hotspot, RTT steps 40->130 ms at 90 s (symmetric)",
    up: (t, r) => (t < 90_000 ? 15 : 60) + expo(r, 5),
    down: (t, r) => (t < 90_000 ? 15 : 60) + expo(r, 5),
    floorBias: () => 0,
  },
  // The same step, but only the uplink gets longer (the hotspot's own uplink saturates)
  hotspotStepAsym: {
    name: "hotspot, uplink only steps +90 ms at 90 s",
    up: (t, r) => (t < 90_000 ? 15 : 105) + expo(r, 5),
    down: (_t, r) => 15 + expo(r, 5),
    floorBias: (t) => (t < 90_000 ? 0 : 45),
  },
  // Home Wi-Fi where someone starts a big upload: for 40 s every uplink segment queues behind it
  uplinkBurst: {
    name: "home Wi-Fi, 40 s uplink congestion at 60 s",
    up: (t, r) => 2.5 + expo(r, 5) + (t >= 60_000 && t < 100_000 ? 40 + expo(r, 40) : 0),
    down: (_t, r) => 2.5 + expo(r, 5),
    floorBias: () => 0,
  },
};

// ---- estimators -----------------------------------------------------------------------------------------
interface Estimator {
  addProbe(t0: number, t1: number, t2: number, t3: number, id?: number, index?: 0 | 1): unknown;
  offsetMs: number | null;
}

/**
 * The proposals, as prototypes (they live here, not in src/). All of them keep *every* probe for
 * NTP_SAMPLE_MAX_AGE_MS instead of only the pairs that pass the 2 ms test: a sample at the RTT floor
 * cannot hide a queue in either direction, and a pair that fails the test on a jittery link is thrown
 * away even when one half of it is the best sample the phone will see all minute.
 *
 *  - `agePpm`: pick the sample with the smallest error *bound*, rtt/2 + agePpm x age, instead of the
 *    smallest RTT: an old sample is a stale sample once the crystal has drifted under it;
 *  - `minFirst`: do not adopt a first estimate from fewer than this many probes (the very first
 *    response may be the one that sat behind a retransmit);
 *  - `hold`: hold-over. Remember the path's RTT floor; when nothing in the window is near it (sustained
 *    one-way congestion, which is what the pair test was built to catch), keep the current offset
 *    instead of following biased samples, and only relearn the floor after HOLD_MS (the path changed).
 */
const HOLD_MS = 60_000;
class FloorWindowEstimator implements Estimator {
  offsetMs: number | null = null;
  private samples: Array<{ offset: number; rtt: number; at: number }> = [];
  private lastSlew = 0;
  private floorRtt = Infinity;
  private lastNearFloorAt = -Infinity;
  constructor(private readonly opts: { agePpm?: number; minFirst?: number; hold?: boolean } = {}) {}
  addProbe(t0: number, t1: number, t2: number, t3: number): void {
    const rtt = t3 - t0 - (t2 - t1);
    this.samples.push({ offset: (t1 - t0 + (t2 - t3)) / 2, rtt, at: t3 });
    this.samples = this.samples.filter((s) => t3 - s.at <= NTP_SAMPLE_MAX_AGE_MS);
    if (this.offsetMs == null && this.samples.length < (this.opts.minFirst ?? 1)) return;
    const ppm = (this.opts.agePpm ?? 0) / 1e6;
    const bound = (s: { rtt: number; at: number }) => s.rtt / 2 + ppm * (t3 - s.at);
    const best = this.samples.reduce((x, y) => (bound(y) < bound(x) ? y : x));
    if (this.opts.hold) {
      this.floorRtt = Math.min(this.floorRtt, rtt);
      if (best.rtt <= this.floorRtt + Math.max(2, 0.25 * this.floorRtt)) this.lastNearFloorAt = t3;
      else if (this.offsetMs != null && t3 - this.lastNearFloorAt < HOLD_MS) return; // hold-over
      else {
        this.floorRtt = best.rtt; // the path itself got longer: relearn
        this.lastNearFloorAt = t3;
      }
    }
    if (this.offsetMs == null) {
      this.offsetMs = best.offset;
    } else {
      const err = best.offset - this.offsetMs;
      const dt = Math.max(0, (t3 - this.lastSlew) / 1000);
      this.offsetMs = Math.abs(err) > RESYNC_THRESHOLD_MS ? best.offset : this.offsetMs + Math.sign(err) * Math.min(Math.abs(err), SLEW_RATE_MS_PER_SEC * dt);
    }
    this.lastSlew = t3;
  }
}

interface Variant {
  name: string;
  make(): Estimator;
  /** Steady-state pairs per second (the engine sends 1). */
  steadyHz?: number;
}
const VARIANTS: Record<string, Variant> = {
  current: { name: "current (coded pairs, min-RTT of 30)", make: () => new ClockModel({ pairs: true }) },
  noPairs: { name: "pair test off (min-RTT of 30)", make: () => new ClockModel({ pairs: false }) },
  current2Hz: { name: "current, 2 pairs/s", make: () => new ClockModel({ pairs: true }), steadyHz: 2 },
  floorWindow: { name: "proposal A: all probes, min-RTT over 30 s", make: () => new FloorWindowEstimator() },
  floorAged: { name: "proposal B: A + age-aware pick, 3-probe start", make: () => new FloorWindowEstimator({ agePpm: 50, minFirst: 3 }) },
  floorHold: { name: "proposal C: B + RTT-floor hold-over", make: () => new FloorWindowEstimator({ agePpm: 50, minFirst: 3, hold: true }) },
  // The same estimators with the steady cadence cut from 1 pair/s to 1 pair per 5 s (the burst is kept):
  // 80 % fewer NTP messages for the server to answer once a phone has settled.
  currentSlow: { name: "current, 1 pair per 5 s", make: () => new ClockModel({ pairs: true }), steadyHz: 0.2 },
  floorHoldSlow: { name: "proposal C, 1 pair per 5 s", make: () => new FloorWindowEstimator({ agePpm: 50, minFirst: 3, hold: true }), steadyHz: 0.2 },
};

// ---- the simulation -------------------------------------------------------------------------------------
interface RunResult {
  /** |applied offset − true offset| on a 100 ms grid, from the first estimate on. */
  errAt: Float64Array;
  /** Signed error on the same grid (NaN before the first estimate). */
  signed: Float64Array;
  firstEstimateMs: number | null;
  /** First instant after which the error stays within SYNC_TARGET_MS / 2 of the link's own bias for 10 s. */
  usableMs: number | null;
  accepted: number;
  rejected: number;
  degraded: boolean;
}

const GRID_MS = 100;

function simulate(link: Link, variant: Variant, seed: number, durationMs: number, driftPpm = 30): RunResult {
  const rand = rng(seed);
  const est = variant.make();
  const off0 = 1_000_000 + rand() * 1000; // server − local at t = 0
  const trueOffset = (t: number) => off0 + (driftPpm / 1e6) * t;
  const local = (t: number) => t - trueOffset(t);

  // Stalls: both directions frozen for stallMs.
  const stalls: Array<[number, number]> = [];
  if (link.stallEveryMs && link.stallMs) {
    for (let t = expo(rand, link.stallEveryMs); t < durationMs; t += link.stallMs + expo(rand, link.stallEveryMs)) stalls.push([t, t + link.stallMs]);
  }
  const afterStall = (t: number) => {
    for (const [a, b] of stalls) if (t >= a && t < b) return b;
    return t;
  };

  // The engine's schedule. A probe() cancels the previous probe's pending second half.
  const steadyMs = NTP_STEADY_INTERVAL_MS / (variant.steadyHz ?? 1);
  const ticks: number[] = [0];
  for (let k = 1; k <= NTP_BURST_COUNT; k++) ticks.push(k * (NTP_BURST_WINDOW_MS / NTP_BURST_COUNT));
  for (let t = steadyMs; t < durationMs; t += steadyMs) ticks.push(t + 0.5); // timers never land on the same ms twice
  ticks.sort((a, b) => a - b);
  const sends: Array<{ t: number; id: number; index: 0 | 1 }> = [];
  ticks.forEach((t, id) => {
    sends.push({ t, id, index: 0 });
    const next = ticks[id + 1];
    if (next === undefined || next - t > NTP_PROBE_PAIR_GAP_MS) sends.push({ t: t + NTP_PROBE_PAIR_GAP_MS + rand() * 1.5, id, index: 1 });
  });
  sends.sort((a, b) => a.t - b.t);

  let lastUp = 0;
  let lastDown = 0;
  const arrivals: Array<{ t3: number; t0: number; t1: number; t2: number; id: number; index: 0 | 1 }> = [];
  for (const s of sends) {
    const lostUp = link.loss && rand() < link.loss ? (link.rtoMs ?? 200) : 0;
    const t1 = Math.max(lastUp + 0.01, afterStall(afterStall(s.t) + link.up(s.t, rand) + lostUp));
    lastUp = t1;
    const t2 = t1 + 0.02;
    const lostDown = link.loss && rand() < link.loss ? (link.rtoMs ?? 200) : 0;
    const t3 = Math.max(lastDown + 0.01, afterStall(afterStall(t2) + link.down(t2, rand) + lostDown));
    lastDown = t3;
    arrivals.push({ t3, t0: s.t, t1, t2, id: s.id, index: s.index });
  }
  arrivals.sort((a, b) => a.t3 - b.t3);

  const points = Math.floor(durationMs / GRID_MS);
  const errAt = new Float64Array(points).fill(NaN);
  const signed = new Float64Array(points).fill(NaN);
  const converged = new Float64Array(points).fill(NaN);
  let firstEstimateMs: number | null = null;
  let next = 0;
  for (let i = 0; i < points; i++) {
    const t = i * GRID_MS;
    while (next < arrivals.length && arrivals[next]!.t3 <= t) {
      const a = arrivals[next++]!;
      // The server stamps true time; the phone stamps its own clock.
      est.addProbe(local(a.t0), a.t1, a.t2, local(a.t3), a.id, a.index);
      if (firstEstimateMs == null && est.offsetMs != null) firstEstimateMs = a.t3;
    }
    if (est.offsetMs != null) {
      // serverNow(localNow) = local + offset; its error against true server time is offset − trueOffset.
      signed[i] = est.offsetMs - trueOffset(t);
      errAt[i] = Math.abs(signed[i]!);
      converged[i] = Math.abs(signed[i]! - link.floorBias(t));
    }
  }
  let usableMs: number | null = null;
  const hold = 10_000 / GRID_MS;
  for (let i = 0; i + hold < points; i++) {
    if (Number.isNaN(converged[i]!)) continue;
    let ok = true;
    for (let j = i; j < i + hold; j++) if (!(converged[j]! <= SYNC_TARGET_MS / 2)) { ok = false; i = j; break; }
    if (ok) { usableMs = i * GRID_MS; break; }
  }
  const model = est as Partial<ClockModel>;
  return { errAt, signed, firstEstimateMs, usableMs, accepted: model.accepted ?? arrivals.length, rejected: model.rejected ?? 0, degraded: model.degraded ?? false };
}

// ---- aggregation ----------------------------------------------------------------------------------------
const pctl = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : NaN);
function dist(values: number[]) {
  const s = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return { p50: pctl(s, 50), p95: pctl(s, 95), max: s.at(-1) ?? NaN, n: s.length };
}

const SEEDS = 40;
const DURATION_MS = 180_000;

interface Cell {
  link: string;
  variant: string;
  /** |error| over the whole run after the first estimate, pooled across seeds. */
  err: ReturnType<typeof dist>;
  /** |error| inside the first 5 s after joining — what the first PLAY is scheduled against. */
  errFirst5s: ReturnType<typeof dist>;
  /** |error| from 10 s on. */
  errSteady: ReturnType<typeof dist>;
  meanSigned: number;
  /** Share of steady-state time spent more than 10 ms / 30 ms wrong, and runs with any >30 ms excursion. */
  over10: number;
  over30: number;
  runsOver30: number;
  firstEstimateMs: ReturnType<typeof dist>;
  usableMs: ReturnType<typeof dist>;
  neverUsable: number;
  acceptance: number;
  degradedRuns: number;
}

const cache = new Map<string, RunResult[]>();
function runs(linkKey: string, variantKey: string): RunResult[] {
  const key = `${linkKey}/${variantKey}`;
  let r = cache.get(key);
  if (!r) cache.set(key, (r = Array.from({ length: SEEDS }, (_, i) => simulate(LINKS[linkKey]!, VARIANTS[variantKey]!, 1000 + i * 7919 + linkKey.length, DURATION_MS))));
  return r;
}

function cell(linkKey: string, variantKey: string): Cell {
  const rs = runs(linkKey, variantKey);
  const all: number[] = [];
  const first: number[] = [];
  const steady: number[] = [];
  let signedSum = 0;
  let signedN = 0;
  let over10 = 0;
  let over30 = 0;
  let runsOver30 = 0;
  for (const r of rs) {
    let excursion = false;
    for (let i = 0; i < r.errAt.length; i++) {
      const v = r.errAt[i]!;
      if (Number.isNaN(v)) continue;
      all.push(v);
      if (i * GRID_MS < 5000) first.push(v);
      if (i * GRID_MS >= 10_000) {
        steady.push(v);
        signedSum += r.signed[i]!;
        signedN++;
        if (v > SYNC_TARGET_MS) over10++;
        if (v > SYNC_FLOOR_MS) {
          over30++;
          excursion = true;
        }
      }
    }
    if (excursion) runsOver30++;
  }
  const accepted = rs.reduce((a, r) => a + r.accepted, 0);
  const rejected = rs.reduce((a, r) => a + r.rejected, 0);
  return {
    link: LINKS[linkKey]!.name,
    variant: VARIANTS[variantKey]!.name,
    err: dist(all),
    errFirst5s: dist(first),
    errSteady: dist(steady),
    meanSigned: signedSum / Math.max(1, signedN),
    over10: over10 / Math.max(1, signedN),
    over30: over30 / Math.max(1, signedN),
    runsOver30,
    firstEstimateMs: dist(rs.map((r) => r.firstEstimateMs ?? NaN)),
    usableMs: dist(rs.map((r) => r.usableMs ?? NaN)),
    neverUsable: rs.filter((r) => r.usableMs == null).length,
    acceptance: accepted / Math.max(1, accepted + rejected),
    degradedRuns: rs.filter((r) => r.degraded).length,
  };
}

/** |errorA − errorB| between two phones on two links: what the room hears as an echo. */
function skew(linkA: string, linkB: string, variantKey: string) {
  const a = runs(linkA, variantKey);
  const b = runs(linkB, variantKey);
  const out: number[] = [];
  for (let s = 0; s < SEEDS; s++) {
    const ra = a[s]!;
    const rb = b[(s + 1) % SEEDS]!; // a different seed, so two phones on the *same* link are still independent
    for (let i = 10_000 / GRID_MS; i < ra.signed.length; i++) {
      const d = ra.signed[i]! - rb.signed[i]!;
      if (!Number.isNaN(d)) out.push(Math.abs(d));
    }
  }
  return dist(out);
}

const f = (v: number, d = 1) => (Number.isNaN(v) ? "n/a" : v.toFixed(d));

// ---- the tests ------------------------------------------------------------------------------------------
describe("clock sync vs. the network", () => {
  test("LAN and home Wi-Fi hold the ±5 ms clock budget", () => {
    const lan = cell("lan", "current");
    expect(lan.err.p95).toBeLessThan(1);
    expect(lan.err.max).toBeLessThan(2);
    expect(lan.firstEstimateMs.max).toBeLessThan(1000);
    const home = cell("homeWifi", "current");
    expect(home.errSteady.p95).toBeLessThan(SYNC_TARGET_MS / 2);
    expect(home.errSteady.max).toBeLessThan(SYNC_TARGET_MS);
    // ...but on ordinary home Wi-Fi one phone in twenty already waits ~2 s for its first estimate,
    // because two thirds of its pairs fail the 2 ms test (see the acceptance test below).
    expect(home.firstEstimateMs.p95).toBeLessThan(3000);
  });

  test("an asymmetric path is invisible: LTE settles on a constant bias of half the up/down floor gap", () => {
    const lte = cell("lte", "current");
    // floors 30 ms up / 15 ms down -> +7.5 ms, plus whatever queueing the best sample still carried
    expect(lte.meanSigned).toBeGreaterThan(LINKS.lte!.floorBias(0) - 1);
    expect(lte.meanSigned).toBeLessThan(LINKS.lte!.floorBias(0) + 8);
    // ...and so a phone on LTE and a phone on the house Wi-Fi disagree by about that much, forever.
    const s = skew("lte", "homeWifi", "current");
    expect(s.p50).toBeGreaterThan(5);
    expect(s.p95).toBeLessThan(SYNC_FLOOR_MS);
  });

  test("the pair test discards most probes on a jittery link", () => {
    // 2 ms of tolerance against tens of ms of jitter: what survives is not the best data, just the luckiest.
    expect(cell("lan", "current").acceptance).toBeGreaterThan(0.85);
    expect(cell("homeWifi", "current").acceptance).toBeLessThan(0.5);
    expect(cell("venueWifi", "current").acceptance).toBeLessThan(0.25);
    expect(cell("lte", "current").acceptance).toBeLessThan(0.25);
  });

  test("a symmetric RTT step does not move the clock; an uplink-only step moves it by half the step", () => {
    const sym = cell("hotspotStep", "current");
    expect(sym.errSteady.p95).toBeLessThan(SYNC_TARGET_MS);
    const asym = runs("hotspotStepAsym", "current");
    // 60 s after the step the old samples have aged out and the estimate has jumped by ~45 ms.
    const late = asym.map((r) => r.signed[150_000 / GRID_MS]!).filter((v) => !Number.isNaN(v));
    const mean = late.reduce((a, b) => a + b, 0) / late.length;
    expect(mean).toBeGreaterThan(35);
    expect(mean).toBeLessThan(60);
  });

  test("the pair test earns its keep in exactly one case: sustained one-way congestion", () => {
    // Turn it off and a 40 s upload on the same Wi-Fi drags the clock ~20 ms; with it, the p95 holds.
    expect(cell("uplinkBurst", "noPairs").errSteady.p95).toBeGreaterThan(15);
    expect(cell("uplinkBurst", "current").errSteady.p95).toBeLessThan(SYNC_TARGET_MS / 2);
    // ...but the sparse window it leaves behind still lets a bad sample through in some runs.
    expect(cell("uplinkBurst", "current").runsOver30).toBeGreaterThan(0);
  });

  test("proposal C (every probe, age-aware pick, RTT-floor hold-over) beats today on every bad link", () => {
    for (const link of ["lan", "homeWifi", "venueWifi", "lte", "uplinkBurst"]) {
      const now = cell(link, "current");
      const proposed = cell(link, "floorHold");
      expect(proposed.errSteady.p95).toBeLessThanOrEqual(now.errSteady.p95);
      expect(proposed.errSteady.max).toBeLessThanOrEqual(now.errSteady.max);
      expect(proposed.runsOver30).toBe(0);
    }
    // First estimate: three probes into the burst, on every link, instead of "when a pair gets lucky".
    for (const link of Object.keys(LINKS)) expect(cell(link, "floorHold").firstEstimateMs.max).toBeLessThan(1000);
    // Its one cost: after a symmetric path change it coasts on the crystal for HOLD_MS before
    // relearning the floor, so that link's p95 goes from ~1.5 ms to ~3.3 ms — still inside ±5 ms.
    expect(cell("hotspotStep", "floorHold").errSteady.p95).toBeLessThan(SYNC_TARGET_MS / 2);
    // And what no estimator can do: an uplink-only step is a real 45 ms bias once the hold-over ends.
    expect(cell("hotspotStepAsym", "floorHold").errSteady.max).toBeGreaterThan(40);
  });

  // ---- measured gaps, written as the behaviour we want ---------------------------------------------------
  test.failing("venue Wi-Fi: every phone has a clock within 2 s of joining", () => {
    expect(cell("venueWifi", "current").firstEstimateMs.max).toBeLessThan(2000);
  });

  test.failing("venue Wi-Fi: no phone is ever more than the 30 ms floor wrong once it has settled", () => {
    // Today 7 of 40 three-minute runs have an excursion past 30 ms (worst 138 ms): the pair test leaves
    // so few samples in the window that a response which sat behind a retransmit becomes "the best".
    expect(cell("venueWifi", "current").runsOver30).toBe(0);
  });

  test.failing("LTE: the fallback after a burst with no accepted pair does not adopt a 100 ms-wrong clock", () => {
    // `degraded` takes the better half of ONE rejected pair; every probe the burst already saw is ignored.
    expect(cell("lte", "current").errFirst5s.max).toBeLessThan(SYNC_FLOOR_MS);
  });

  test("report", async () => {
    const path = process.env.NET_REPORT;
    const links = Object.keys(LINKS);
    const variants = Object.keys(VARIANTS);
    const cells = links.flatMap((l) => variants.map((v) => cell(l, v)));
    const pairs: Array<[string, string]> = [["lan", "lan"], ["homeWifi", "homeWifi"], ["lan", "homeWifi"], ["homeWifi", "lte"], ["homeWifi", "venueWifi"], ["venueWifi", "venueWifi"], ["venueWifi", "lte"], ["lan", "hotspotStepAsym"], ["lan", "uplinkBurst"]];
    const skews = pairs.flatMap(([a, b]) => ["current", "floorHold"].map((v) => ({ a: LINKS[a]!.name, b: LINKS[b]!.name, variant: VARIANTS[v]!.name, ...skew(a, b, v) })));
    const lines = [
      `Clock-offset error by link and estimator — ${SEEDS} seeded runs x ${DURATION_MS / 1000} s each, 30 ppm crystal drift, error sampled every ${GRID_MS} ms`,
      `columns: |err| p50/p95/max ms over the whole run | first 5 s p95/max | steady (>=10 s) p50/p95/max | mean signed | steady time >10 ms / >30 ms wrong, runs with a >30 ms excursion | first estimate p50/p95/max ms | converged (within 5 ms of the link's own bias, held 10 s) p50/p95 ms, runs never | probes accepted | degraded runs`,
      ...cells.map(
        (c) =>
          `${c.link.padEnd(46)} | ${c.variant.padEnd(46)} | ${f(c.err.p50)}/${f(c.err.p95)}/${f(c.err.max)} | ${f(c.errFirst5s.p95)}/${f(c.errFirst5s.max)} | ${f(c.errSteady.p50)}/${f(c.errSteady.p95)}/${f(c.errSteady.max)} | ${f(c.meanSigned)} | ${(c.over10 * 100).toFixed(2)}% / ${(c.over30 * 100).toFixed(2)}%, ${c.runsOver30}/${SEEDS} | ${f(c.firstEstimateMs.p50, 0)}/${f(c.firstEstimateMs.p95, 0)}/${f(c.firstEstimateMs.max, 0)} | ${f(c.usableMs.p50, 0)}/${f(c.usableMs.p95, 0)}, ${c.neverUsable}/${SEEDS} | ${(c.acceptance * 100).toFixed(0)}% | ${c.degradedRuns}`,
      ),
      ``,
      `Skew between two phones (|errA - errB|, steady state): p50/p95/max ms`,
      ...skews.map((s) => `${s.a.padEnd(46)} vs ${s.b.padEnd(46)} | ${s.variant.padEnd(46)} | ${f(s.p50)}/${f(s.p95)}/${f(s.max)}`),
    ];
    if (path) {
      await Bun.write(`${path}.txt`, lines.join("\n") + "\n");
      await Bun.write(`${path}.json`, JSON.stringify({ seeds: SEEDS, durationMs: DURATION_MS, cells, skews }, null, 2) + "\n");
    }
    expect(cells.length).toBe(links.length * variants.length);
  });
});
