/**
 * B3-lite, second half: two full `createHiveClient`s against the mock server, with a fake AudioContext
 * in place of a browser's. Both must reach `audio: ready` and agree on the timeline.
 *
 * The gate asks for "the same `trackTimeSec` within 5 ms", which is really a check on the clock. The
 * stronger assertion here is the one the acoustic rig will make later, computed headlessly: take each
 * client's scheduled start (`debug.startCtxForZero`, the ctx time at which track position 0 leaves its
 * speaker), map it back to the server clock, and compare. That number IS device-to-device skew — the
 * rig measures the same quantity with a microphone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { SYNC_TARGET_MS } from "@hive/protocol";
import { createHiveClient } from "../index";
import { createBrowserAudioEngine } from "../audio";
import { CtxMapper } from "../clock";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const PORT = 19480 + Math.floor(Math.random() * 400);
let mock: ReturnType<typeof startMockServer>;

beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
  await mock.ready;
});
afterAll(() => mock.stop());

const STEMS = ["drums", "bass", "vocals", "other"];

interface Harness {
  client: ReturnType<typeof createHiveClient>;
  ctx: FakeAudioContext;
  mapper: CtxMapper;
  engine: { debug: { startCtxForZero: number | null; playing: boolean; loadedTrackId: string | null } };
}

/**
 * A client whose AudioContext is a fake with a real-time clock, and whose stems resolve instantly to
 * 60 s buffers. Everything else — transport, clock, scheduler — is the production code path.
 */
function harness(clientId: string, kind: "host" | "player", plays: boolean): Harness {
  const ctxOrigin = performance.now();
  const ctx = new FakeAudioContext({ clock: () => (performance.now() - ctxOrigin) / 1000 });
  let mapper!: CtxMapper;
  let engine!: Harness["engine"];
  const client = createHiveClient(
    {
      wsUrl: `ws://localhost:${PORT}/ws`,
      apiUrl: `http://localhost:${PORT}`,
      roomCode: "BZQ7",
      kind,
      plays,
      hostKey: kind === "host" ? mock.hostKey : undefined,
      clientId,
    },
    {
      createAudioEngine: (host) => {
        mapper = host.mapper;
        const made = createBrowserAudioEngine(host, {
          createContext: () => ctx as unknown as AudioContext,
          loadStem: async () => new FakeBuffer(60, ctx.sampleRate) as unknown as AudioBuffer,
        });
        engine = made as unknown as Harness["engine"];
        return made;
      },
    },
  );
  return { client, ctx, mapper, engine };
}

const waitFor = async (pred: () => boolean, timeoutMs = 5000, what = "condition") => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe("two engines against the mock server", () => {
  test("both reach audio: ready, send AUDIO_READY, and schedule the same instant", async () => {
    const a = harness("smoke-player-a", "player", true);
    const b = harness("smoke-player-b", "player", true);
    const host = harness("smoke-host", "host", false);

    try {
      await Promise.all([a.client.connect(), b.client.connect(), host.client.connect()]);

      // The clock has to be up before anything is scheduled, exactly as on a real phone.
      await waitFor(
        () => a.client.status.clockOffsetMs !== null && b.client.status.clockOffsetMs !== null,
        5000,
        "both clocks",
      );

      // unlock() is the tap handler on a phone; here it just builds the graph and loads the stems.
      await Promise.all([a.client.audio.unlock(), b.client.audio.unlock()]);
      await waitFor(() => a.client.audio.state === "ready" && b.client.audio.state === "ready", 5000, "audio ready");
      expect(a.client.audio.loadProgress).toBe(1);
      expect(a.engine.debug.loadedTrackId).toBe("synthetic-60s");

      // the server heard about it (AUDIO_READY → audioReadyTrackId in the snapshot)
      await waitFor(
        () => a.client.room?.clients["smoke-player-a"]?.audioReadyTrackId === "synthetic-60s",
        4000,
        "AUDIO_READY on the server",
      );

      host.client.host.play(0);
      await waitFor(() => a.engine.debug.playing && b.engine.debug.playing, 4000, "both playing");

      const transport = a.client.room!.transport;
      if (transport.state !== "playing") throw new Error("expected playing");
      const zero = transport.serverTimeAtTrackZero;

      // Each client's scheduled emission of track position 0, expressed on the server clock.
      const emitted = (h: Harness): number => {
        const startCtx = h.engine.debug.startCtxForZero!;
        const comp = h.client.assignment?.compensationMs ?? 0;
        // startCtxForZero already has compensation subtracted; add it back to get the *emission* time.
        const server = h.mapper.serverTimeForCtx(startCtx + comp / 1000);
        if (server == null) throw new Error("no ctx mapping yet");
        return server;
      };
      const ea = emitted(a);
      const eb = emitted(b);

      // Each phone emits position 0 when the timeline says it should...
      expect(Math.abs(ea - zero)).toBeLessThan(SYNC_TARGET_MS);
      expect(Math.abs(eb - zero)).toBeLessThan(SYNC_TARGET_MS);
      // ...so they agree with each other, which is the number that matters on stage.
      const skewMs = Math.abs(ea - eb);
      expect(skewMs).toBeLessThan(SYNC_TARGET_MS);

      // and the weaker check the gate asks for, on the clock rather than the scheduler
      const dtMs = Math.abs(a.client.clock.trackTimeSec() - b.client.clock.trackTimeSec()) * 1000;
      expect(dtMs).toBeLessThan(5);

      // every stem started at one identical ctx time on each device
      for (const h of [a, b]) {
        const starts = h.ctx.allStarts();
        expect(starts.length).toBeGreaterThanOrEqual(STEMS.length);
        const last = starts.slice(-STEMS.length);
        expect(new Set(last.map((s) => s.when)).size).toBe(1);
        expect(new Set(last.map((s) => s.offset)).size).toBe(1);
      }

      console.log(
        `[B3] two engines: device-to-device skew ${skewMs.toFixed(3)} ms ` +
          `(A ${(ea - zero).toFixed(3)} ms, B ${(eb - zero).toFixed(3)} ms vs the timeline), ` +
          `trackTimeSec agreement ${dtMs.toFixed(3)} ms`,
      );

      // pause stops both, and play again reschedules both
      host.client.host.pause();
      await waitFor(() => !a.engine.debug.playing && !b.engine.debug.playing, 4000, "both paused");
      host.client.host.play(10);
      await waitFor(() => a.engine.debug.playing && b.engine.debug.playing, 4000, "both playing again");
      expect(a.client.clock.trackTimeSec()).toBeGreaterThan(0);
    } finally {
      a.client.disconnect();
      b.client.disconnect();
      host.client.disconnect();
    }
  }, 30_000);

  test("a client that joins mid-track starts immediately at the right offset", async () => {
    const host = harness("late-host", "host", false);
    const late = harness("late-player", "player", true);
    try {
      await host.client.connect();
      await waitFor(() => host.client.status.clockOffsetMs !== null, 5000, "host clock");
      host.client.host.play(0);
      await waitFor(() => host.client.room?.transport.state === "playing", 4000, "playing");

      // Two seconds of music have gone by before this phone has even unlocked.
      await new Promise((r) => setTimeout(r, 2000));
      await late.client.connect();
      await waitFor(() => late.client.status.clockOffsetMs !== null, 5000, "late clock");
      await late.client.audio.unlock();
      await waitFor(() => late.engine.debug.playing, 5000, "late player playing");

      const decision = (late.engine as unknown as { debug: { lastDecision: { mode: string; offsetSec: number } } }).debug.lastDecision;
      expect(decision.mode).toBe("immediate");
      expect(decision.offsetSec).toBeGreaterThan(1); // it joined well into the track...

      // ...and the offset it chose is where the timeline actually was. trackTimeSec() is read after
      // the decision, so it must be slightly ahead of the offset and never behind it.
      const positionNow = late.client.clock.trackTimeSec();
      expect(decision.offsetSec).toBeLessThanOrEqual(positionNow + 0.05);
      expect(positionNow - decision.offsetSec).toBeLessThan(0.5);
      console.log(
        `[B3] late join started at offset ${decision.offsetSec.toFixed(3)} s without waiting ` +
          `(timeline was at ${positionNow.toFixed(3)} s)`,
      );
    } finally {
      host.client.disconnect();
      late.client.disconnect();
    }
  }, 30_000);
});
