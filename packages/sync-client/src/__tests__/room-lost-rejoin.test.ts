/**
 * PARTY-01 · a phone whose room is gone can ask again.
 *
 * After a restart the server answers a JOIN for a room its host has not restored with `ERROR NO_ROOM`
 * and leaves the socket open. Nothing ever closes that socket, so the reconnect loop does not run
 * again; and `connect()` saw an open socket and resolved without doing anything. A guest page that
 * wanted to wait for the host had no way to try again short of `disconnect()` — which tears the audio
 * engine down. `connect()` on a socket whose JOIN was refused now replaces it and JOINs again.
 */
import { describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { createHiveClient } from "../index";

const port = (): number => 18900 + Math.floor(Math.random() * 900);
const urls = (p: number) => ({ wsUrl: `ws://localhost:${p}/ws`, apiUrl: `http://localhost:${p}`, roomCode: "BZQ7" });
const waitFor = async (pred: () => boolean, what: string, timeoutMs = 8000) => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = (p: Promise<void>) =>
  p.then(
    () => "resolved",
    (e: Error) => `rejected: ${e.message}`,
  );

describe("PARTY-01 · NO_ROOM after a successful join", () => {
  test("the refused socket is not retried by itself; connect() tries again, and gets back in when the room returns", async () => {
    const p = port();
    const mock = startMockServer({ port: p, quiet: true, scenario: { players: [] } });
    await mock.ready;
    const client = createHiveClient({ ...urls(p), kind: "player", plays: true, clientId: "room-lost-0001" });
    const errors: string[] = [];
    client.on("error", (code) => errors.push(code));
    try {
      await client.connect();
      await waitFor(() => client.me !== null, "the first snapshot");
      expect(mock.received.JOIN).toBe(1);

      // a healthy connection: connect() again is still a no-op (P0-4)
      expect(await settle(client.connect())).toBe("resolved");
      expect(mock.received.JOIN).toBe(1);

      mock.loseRoom(); // restart; the host has not brought the room back
      await waitFor(() => errors.includes("NO_ROOM"), "the reconnect being refused");
      expect(mock.received.JOIN).toBe(2);
      expect(client.room).not.toBeNull(); // the page can tell "was in this hive" from "never got in"

      // left alone, the transport asks nothing more: the socket is open, just not in a room
      await new Promise((r) => setTimeout(r, 1500));
      expect(mock.received.JOIN).toBe(2);

      // still gone: the retry is one more JOIN, refused the same way
      expect(await settle(client.connect())).toBe("rejected: NO_ROOM: room BZQ7 does not exist");
      expect(mock.received.JOIN).toBe(3);
      expect(errors).toEqual(["NO_ROOM", "NO_ROOM"]);

      mock.restoreRoom(); // the host is back
      expect(await settle(client.connect())).toBe("resolved");
      expect(mock.received.JOIN).toBe(4);
      expect(client.connection).toBe("open");
      await waitFor(() => client.me?.connected === true, "the snapshot after the return");
      expect(client.clientId).toBe("room-lost-0001");
    } finally {
      client.disconnect();
      mock.stop();
    }
  }, 20_000);
});
