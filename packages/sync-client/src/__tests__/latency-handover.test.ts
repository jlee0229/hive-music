/**
 * ENGINE-SYNC-04 · the latency-compensation handover.
 *
 * A phone joins with a per-browser table guess folded into `compensationMs` (45 ms for Android Chrome).
 * The first CLIENT_STATUS that carries a real `ctx.outputLatency` makes the server null `tableLatencyMs`
 * and re-plan, so ONE snapshot both drops the guess from `compensationMs` and flips the client's
 * `useOutputLatency()` on. The two are applied atomically by the engine — there is no window with both or
 * neither — but the scheduler compared only the assignment's half of the shift and saw a 45 ms jump.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RESYNC_THRESHOLD_MS } from "@hive/protocol";
import { engineRig, LOCAL0, makeAssignment, STEMS } from "./engine-rig";
import { flushMicrotasks, VirtualTime } from "./sim";

let vt: VirtualTime;
beforeEach(() => {
  vt = new VirtualTime().install();
});
afterEach(() => vt.uninstall());

const ZERO = LOCAL0 + 600;

/** A phone playing on the table guess, about to be handed over to its measured output latency. */
async function onTheTable(outputLatency: number, tableMs = 45) {
  const r = engineRig(vt, { outputLatency });
  await r.engine.unlock();
  r.apply({ transport: r.playingAt(ZERO), assignment: makeAssignment({ compensationMs: tableMs }), tableLatencyMs: tableMs });
  await flushMicrotasks();
  vt.advance(2000); // the first CLIENT_STATUS goes out about now
  const handOver = () =>
    r.apply({ transport: r.playingAt(ZERO), assignment: makeAssignment({ compensationMs: 0 }), tableLatencyMs: null });
  /** When track position 0 left (or would have left) the speaker, in ms on the local clock. */
  const zeroAtMs = () => {
    const live = r.ctx.liveSources(r.ctx.currentTime + 0.06)[0]!;
    return (live.starts[0]!.when - live.starts[0]!.offset - 10) * 1000;
  };
  return { r, handOver, zeroAtMs };
}

describe("ENGINE-SYNC-04 · table guess → measured output latency", () => {
  test("a guess close to the measurement does not interrupt the music", async () => {
    const { r, handOver, zeroAtMs } = await onTheTable(0.04);
    const built = r.ctx.sources.length;
    const before = zeroAtMs();
    expect(before).toBeCloseTo(600 - 45, 6);

    handOver();
    expect(r.ctx.sources.length).toBe(built); // no stop-and-restart
    expect(r.engine.debug.resyncCount).toBe(0);

    // the 5 ms between guess and measurement is absorbed by the rate trim, without a crossfade
    vt.advance(1000);
    expect(Math.abs(r.engine.debug.driftErrorMs as number)).toBeCloseTo(5, 1);
    vt.advance(30_000);
    expect(r.ctx.sources.length).toBe(built);
    expect(r.engine.debug.resyncCount).toBe(0);
    expect(Math.abs(r.engine.debug.driftErrorMs as number)).toBeLessThan(1);
  });

  test("never both and never neither: across the handover the playhead moves by (guess − measured), nothing else", async () => {
    for (const [olSec, tableMs] of [[0.012, 45], [0.09, 45], [0.04, 60]] as const) {
      const { r, handOver, zeroAtMs } = await onTheTable(olSec, tableMs);
      const before = zeroAtMs();
      handOver();
      vt.advance(100);
      const after = zeroAtMs();
      // bigger than the threshold here, so it is rescheduled at once — onto exactly the measured value
      expect(Math.abs(tableMs - olSec * 1000)).toBeGreaterThan(RESYNC_THRESHOLD_MS);
      expect(after - before).toBeCloseTo(tableMs - olSec * 1000, 6);
      expect(after).toBeCloseTo(600 - olSec * 1000, 6);
      expect(r.ctx.liveSources(r.ctx.currentTime + 0.06)).toHaveLength(STEMS.length);
      r.engine.dispose();
    }
  });

  test("a route change mid-song (Bluetooth adds 150 ms) is corrected once, not once per snapshot", async () => {
    const { r, handOver } = await onTheTable(0.04);
    handOver();
    vt.advance(5000);
    const built = r.ctx.sources.length;
    r.ctx.outputLatency = 0.19;
    vt.advance(1100); // the next drift check sees 150 ms and crossfades
    expect(r.engine.debug.resyncCount).toBe(1);
    expect(r.ctx.sources.length).toBe(built + STEMS.length);
    // later snapshots carry nothing new and must not restart the audio again
    for (let i = 0; i < 5; i++) {
      handOver();
      vt.advance(500);
    }
    expect(r.ctx.sources.length).toBe(built + STEMS.length);
    expect(r.engine.debug.resyncCount).toBe(1);
  });

  test("an outputLatency that reads 0 or NaN later does not drop the compensation the phone was playing with", async () => {
    const { r, handOver, zeroAtMs } = await onTheTable(0.04);
    handOver();
    vt.advance(20_000);
    const built = r.ctx.sources.length;
    const settled = zeroAtMs();
    for (const bad of [0, Number.NaN]) {
      r.ctx.outputLatency = bad;
      handOver();
      vt.advance(5000);
      expect(r.ctx.sources.length).toBe(built);
      expect(zeroAtMs()).toBe(settled);
      expect(Number.isFinite(r.engine.debug.driftErrorMs as number)).toBe(true);
    }
    // and a pause/play while it still reads 0 schedules with the remembered 40 ms, not with none
    r.apply({ transport: { state: "paused", trackTimeAtPause: 20 }, assignment: makeAssignment(), tableLatencyMs: null });
    const zero = r.localMs() + 600 - 20_000;
    r.apply({ transport: r.playingAt(zero), assignment: makeAssignment(), tableLatencyMs: null });
    vt.advance(700);
    expect(zeroAtMs() - (zero - LOCAL0)).toBeCloseTo(-40, 6);
  });
});
