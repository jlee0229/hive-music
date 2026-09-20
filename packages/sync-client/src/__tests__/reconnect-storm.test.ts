/**
 * A reconnect storm: 12 phones playing, the server drops every socket at once (1012, service restart),
 * and all 12 have to come back — to the *same* position on the *same* timeline, with one set of audio
 * each.
 *
 * This is the failure the demo is most likely to hit, because it is the only one that happens to every
 * phone simultaneously. Three things can go wrong and only one of them is a disconnect:
 *
 *  1. a phone never comes back (backoff too long, or the reconnect races a manual connect — P0-4);
 *  2. a phone comes back **twice**, and plays two copies of the track a few ms apart. That is the one an
 *     audience actually hears, as flanging, and the room's health stays green throughout;
 *  3. the phones come back to different positions, so the room is in sync with the server and out of sync
 *     with itself.
 *
 * The assertions below are therefore about live source counts and device-to-device agreement, not about
 * the connection state — "connected" is the easy half.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { SYNC_TARGET_MS } from "@hive/protocol";
import { createHiveClient } from "../index";
import { createBrowserAudioEngine } from "../audio";
import { CtxMapper } from "../clock";
import { FakeAudioContext, FakeBuffer, type FakeSource } from "./fake-audio";

const PORT = 19600 + Math.floor(Math.random() * 300);
const PLAYERS = 12;
/** The budget the brief sets for a full room coming back. */
const RESUME_BUDGET_MS = 5000;

let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
  await mock.ready;
});
afterAll(() => mock.stop());

const STEMS = ["drums", "bass", "vocals", "other"];

interface Harness {
  id: string;
  client: ReturnType<typeof createHiveClient>;
  ctx: FakeAudioContext;
  mapper: CtxMapper;
  engine: { debug: { startCtxForZero: number | null; playing: boolean; loadedTrackId: string | null; resyncCount: number } };
}

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
  return { id: clientId, client, ctx, mapper, engine };
}

const waitFor = async (pred: () => boolean, timeoutMs = 10_000, what = "condition") => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

/**
 * Stem sources that were started and never stopped: what is making sound right now.
 *
 * The duration filter skips the one-sample buffer `unlock()` plays to prime the context (and a
 * calibration click, if one ever fired here) — both are started, never explicitly stopped, and neither is
 * music.
 */
const liveSources = (ctx: FakeAudioContext): FakeSource[] =>
  ctx.sources.filter((s) => s.starts.length > 0 && s.stops.length === 0 && (s.buffer?.duration ?? 0) > 1);

/** Where this phone emits track position 0, on the shared clock. */
function emittedZero(h: Harness): number {
  const startCtx = h.engine.debug.startCtxForZero;
  if (startCtx === null) throw new Error(`${h.id} has nothing scheduled`);
  const comp = h.client.assignment?.compensationMs ?? 0;
  const server = h.mapper.serverTimeForCtx(startCtx + comp / 1000);
  if (server == null) throw new Error(`${h.id} has no ctx mapping`);
  return server;
}

describe("12 phones, one server restart", () => {
  test("every phone resumes inside the budget, with one set of audio and the room still in sync", async () => {
    const host = harness("storm-host-01", "host", false);
    const players = Array.from({ length: PLAYERS }, (_, i) => harness(`storm-p-${String(i).padStart(3, "0")}`, "player", true));
    const all = [host, ...players];

    try {
      await Promise.all(all.map((h) => h.client.connect()));
      await waitFor(() => all.every((h) => h.client.status.clockOffsetMs !== null), 15_000, "12 clocks");
      await Promise.all(players.map((h) => h.client.audio.unlock()));
      await waitFor(() => players.every((h) => h.client.audio.state === "ready"), 15_000, "12 × audio ready");

      host.client.host.play(0);
      await waitFor(() => players.every((h) => h.engine.debug.playing), 10_000, "12 playing");

      // baseline: every phone agrees with the timeline and with every other phone
      const zero = (() => {
        const t = host.client.room!.transport;
        if (t.state !== "playing") throw new Error("expected playing");
        return t.serverTimeAtTrackZero;
      })();
      const before = players.map(emittedZero);
      const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
      expect(spread(before)).toBeLessThan(SYNC_TARGET_MS);
      for (const h of players) expect(liveSources(h.ctx)).toHaveLength(STEMS.length);

      const joinsBefore = mock.received.JOIN ?? 0;
      const readyBefore = mock.received.AUDIO_READY ?? 0;

      // ---- the storm ---------------------------------------------------------
      const stormAt = performance.now();
      mock.simulateRestart();

      /*
       * 1 · everybody comes back, inside the budget. Wait on the server's JOIN count, not on
       *     `client.connection` or the room snapshot: both of those were ALREADY "open"/"connected"
       *     before the storm, so waiting on them resolves on stale state in the microsecond before the
       *     close event is even delivered — the first version of this test "resumed in 0 ms" with zero
       *     JOINs. A re-JOIN per phone is the one signal that can only mean the round trip happened.
       */
      await waitFor(
        () => (mock.received.JOIN ?? 0) - joinsBefore >= PLAYERS,
        RESUME_BUDGET_MS,
        `all ${PLAYERS} phones to re-JOIN inside ${RESUME_BUDGET_MS} ms`,
      );
      const rejoinedMs = performance.now() - stormAt;
      // `connection` flips to "open" on WELCOME, one round trip after the JOIN above, so this is a wait
      // and not an assertion — but it shares the storm's budget rather than getting a fresh one.
      const left = () => Math.max(0, RESUME_BUDGET_MS - (performance.now() - stormAt));
      await waitFor(() => players.every((h) => h.client.connection === "open"), left(), "12 × WELCOME");
      await waitFor(
        () => players.every((h) => h.client.room?.clients[h.id]?.connected === true),
        left(),
        "the server sees all 12 again",
      );

      // 2 · one set of audio each. A phone that reconnected twice would have 8 live sources here, and
      //     would sound like flanging while reporting perfect health.
      await waitFor(() => players.every((h) => h.engine.debug.playing), left(), "12 playing again");
      const resumeMs = performance.now() - stormAt;
      expect(resumeMs).toBeLessThan(RESUME_BUDGET_MS); // the budget covers the whole round trip
      for (const h of players) {
        const live = liveSources(h.ctx);
        expect(live).toHaveLength(STEMS.length);
        // and the live set is one simultaneous start, not two branches whose sources happen to total 4
        expect(new Set(live.map((s) => s.starts[0]!.when)).size).toBe(1);
        expect(new Set(live.map((s) => s.starts[0]!.offset)).size).toBe(1);
      }

      // 3 · still in sync with the timeline and with each other
      const after = players.map(emittedZero);
      expect(Math.abs(Math.max(...after.map((x) => Math.abs(x - zero))))).toBeLessThan(SYNC_TARGET_MS);
      expect(spread(after)).toBeLessThan(SYNC_TARGET_MS);

      // 4 · exactly one JOIN per phone, and no phone re-announced AUDIO_READY more than once. A storm
      //     that produced two JOINs for one phone is P0-4 wearing a different hat.
      const joins = (mock.received.JOIN ?? 0) - joinsBefore;
      const readies = (mock.received.AUDIO_READY ?? 0) - readyBefore;
      expect(joins).toBeGreaterThanOrEqual(PLAYERS); // everyone came back…
      expect(joins).toBeLessThanOrEqual(all.length); // …and nobody came back twice
      expect(readies).toBeLessThanOrEqual(PLAYERS);

      console.log(
        `[B9e/storm] ${PLAYERS} phones re-JOINed in ${rejoinedMs.toFixed(0)} ms, playing again at ` +
          `${resumeMs.toFixed(0)} ms (budget ${RESUME_BUDGET_MS}) · ` +
          `${joins} JOINs, ${readies} AUDIO_READYs on the way back · ` +
          `spread ${spread(before).toFixed(3)} → ${spread(after).toFixed(3)} ms · ` +
          `live sources per phone ${liveSources(players[0]!.ctx).length}`,
      );
    } finally {
      for (const h of all) h.client.disconnect();
    }
  }, 90_000);

  test("a second storm is not worse than the first (no leak of sockets or branches)", async () => {
    const host = harness("storm2-host-01", "host", false);
    const players = Array.from({ length: 4 }, (_, i) => harness(`storm2-p-${i}`, "player", true));
    const all = [host, ...players];
    try {
      await Promise.all(all.map((h) => h.client.connect()));
      await waitFor(() => all.every((h) => h.client.status.clockOffsetMs !== null), 15_000, "clocks");
      await Promise.all(players.map((h) => h.client.audio.unlock()));
      await waitFor(() => players.every((h) => h.client.audio.state === "ready"), 15_000, "audio ready");
      host.client.host.play(0);
      await waitFor(() => players.every((h) => h.engine.debug.playing), 10_000, "playing");

      for (let round = 1; round <= 3; round++) {
        const joinsBefore = mock.received.JOIN ?? 0;
        mock.simulateRestart();
        await waitFor(
          () => (mock.received.JOIN ?? 0) - joinsBefore >= players.length,
          RESUME_BUDGET_MS,
          `round ${round} re-JOINs`,
        );
        await waitFor(() => players.every((h) => h.engine.debug.playing), RESUME_BUDGET_MS, `round ${round} playing`);
        for (const h of players) {
          // the invariant that must hold after every round, not just the first
          expect(liveSources(h.ctx)).toHaveLength(STEMS.length);
        }
      }
      console.log(`[B9e/storm] three consecutive restarts: still ${STEMS.length} live sources per phone`);
    } finally {
      for (const h of all) h.client.disconnect();
    }
  }, 90_000);
  /*
   * The case the storm above does NOT cover, and the reason the engine re-announces readiness: a restart
   * that loses the room. `AUDIO_READY` used to be sent exactly once, at the end of decoding, so a server
   * with a fresh room would never learn that the phones already hold the stems — the host's "9 of 12
   * ready" would stay wrong for the rest of the set, and any readiness gate on the server would never
   * open. Nothing reconnects wrongly here; the phone is simply silent about something the server no
   * longer knows. This test replaces the server outright, so it runs last in the file.
   */
  test("a restart that loses the room gets readiness re-announced, unprompted", async () => {
    const host = harness("fresh-host-01", "host", false);
    const player = harness("fresh-p-01", "player", true);
    try {
      await Promise.all([host.client.connect(), player.client.connect()]);
      await waitFor(() => player.client.status.clockOffsetMs !== null, 15_000, "clock");
      await player.client.audio.unlock();
      await waitFor(() => player.client.audio.state === "ready", 15_000, "audio ready");
      await waitFor(
        () => mock.room.clients["fresh-p-01"]?.audioReadyTrackId === "synthetic-60s",
        5000,
        "the first AUDIO_READY",
      );

      // a genuinely new server on the same port: new room, no memory of anyone
      mock.stop();
      mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
      await mock.ready;
      expect(mock.room.clients["fresh-p-01"]).toBeUndefined();

      // the phone comes back and tells the new server what it already holds, without being asked
      await waitFor(() => (mock.received.JOIN ?? 0) >= 1, 10_000, "re-JOIN against the new server");
      await waitFor(
        () => mock.room.clients["fresh-p-01"]?.audioReadyTrackId === "synthetic-60s",
        10_000,
        "readiness re-announced to a server that never heard it",
      );

      // and it is not a loop: the guard holds it to roughly one message per ROOM_STATE period
      const readies = mock.received.AUDIO_READY ?? 0;
      await new Promise((r) => setTimeout(r, 1500));
      expect((mock.received.AUDIO_READY ?? 0) - readies).toBe(0);
      console.log(`[B9e/storm] readiness re-announced to a fresh server after ${readies} AUDIO_READY(s), then quiet`);
    } finally {
      host.client.disconnect();
      player.client.disconnect();
    }
  }, 90_000);
});
