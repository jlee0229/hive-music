/**
 * ENGINE-SYNC-10 · a kicked phone goes quiet.
 *
 * KICK removes the phone from the room and closes its socket. From then on no pause, stop or track
 * change can reach it — so whatever it had scheduled played on to the end of the song, on a phone the
 * host had just removed and could no longer control. (The player page shows "Removed from hive" but
 * never calls `disconnect()`.)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { createHiveClient } from "../index";
import { createBrowserAudioEngine } from "../audio";
import { FakeAudioContext, FakeBuffer } from "./fake-audio";

const PORT = 18100 + Math.floor(Math.random() * 700);
let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
  await mock.ready;
});
afterAll(() => mock.stop());

const base = () => ({ wsUrl: `ws://localhost:${PORT}/ws`, apiUrl: `http://localhost:${PORT}`, roomCode: "BZQ7" });
const waitFor = async (pred: () => boolean, what: string, timeoutMs = 4000) => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("ENGINE-SYNC-10 · KICKED", () => {
  test("the kicked phone stops sounding, releases its context, and tells the UI", async () => {
    const origin = performance.now();
    const ctx = new FakeAudioContext({ clock: () => (performance.now() - origin) / 1000 });
    const host = createHiveClient({ ...base(), kind: "host", plays: false, hostKey: mock.hostKey, clientId: "kick-host-0001" });
    const player = createHiveClient(
      { ...base(), kind: "player", plays: true, name: "Guest", clientId: "kick-play-0001" },
      {
        createAudioEngine: (h) =>
          createBrowserAudioEngine(h, {
            createContext: () => ctx as unknown as AudioContext,
            loadStem: async () => new FakeBuffer(60, ctx.sampleRate) as unknown as AudioBuffer,
          }),
      },
    );
    const errors: string[] = [];
    const audioStates: string[] = [];
    player.on("error", (code) => errors.push(code));
    player.on("audio", (s) => audioStates.push(s));
    try {
      await player.audio.unlock();
      await Promise.all([host.connect(), player.connect()]);
      await waitFor(() => host.room?.track != null, "a track");
      host.host.play(0);
      const music = () => ctx.sources.filter((s) => s.buffer && s.buffer.duration > 1);
      await waitFor(() => music().some((s) => s.liveAt(ctx.currentTime)), "the player to be sounding");

      host.host.kick("kick-play-0001");
      await waitFor(() => errors.includes("KICKED"), "the KICKED error");

      // silent within the stop fade, with nothing left scheduled for later
      await new Promise((r) => setTimeout(r, 60));
      expect(music().filter((s) => s.liveAt(ctx.currentTime))).toHaveLength(0);
      expect(music().every((s) => s.endsAt <= ctx.currentTime)).toBe(true);
      expect(ctx.state).toBe("closed");
      expect(player.audio.state).toBe("locked");
      expect(audioStates.at(-1)).toBe("locked");
      expect(player.room).toBeNull();
      await waitFor(() => player.connection === "closed", "the socket to close");
      // and it stays gone: no reconnect
      await new Promise((r) => setTimeout(r, 900));
      expect(player.connection).toBe("closed");
      expect(Object.keys(host.room!.clients)).not.toContain("kick-play-0001");
    } finally {
      host.disconnect();
      player.disconnect();
    }
  }, 15_000);
});
