/**
 * ENGINE-SYNC-11 · connect() while the server is unreachable.
 */
import { describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import { createHiveClient } from "../index";

const port = (): number => 17000 + Math.floor(Math.random() * 900);
const urls = (p: number) => ({ wsUrl: `ws://localhost:${p}/ws`, apiUrl: `http://localhost:${p}`, roomCode: "BZQ7" });
const waitFor = async (pred: () => boolean, what: string, timeoutMs = 6000) => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("ENGINE-SYNC-11 · connect() when the server is not there", () => {
  test("the promise settles (rejects) instead of hanging, and the client still connects by itself later", async () => {
    const p = port();
    const client = createHiveClient({ ...urls(p), kind: "player", plays: true, clientId: "late-server-0001" });
    let mock: ReturnType<typeof startMockServer> | null = null;
    try {
      const outcome = await Promise.race([
        client.connect().then(
          () => "resolved",
          (e: Error) => `rejected: ${e.message}`,
        ),
        new Promise<string>((r) => setTimeout(() => r("still pending after 3 s"), 3000)),
      ]);
      expect(outcome).toBe("rejected: connection closed before WELCOME");
      expect(client.connection).toBe("reconnecting"); // it has not given up; only that attempt is over

      // the server comes up (a deploy finishing): no further call is needed
      mock = startMockServer({ port: p, quiet: true, scenario: { players: [] } });
      await mock.ready;
      await waitFor(() => client.connection === "open", "the automatic reconnect");
      await waitFor(() => client.me !== null, "the first snapshot");
    } finally {
      client.disconnect();
      mock?.stop();
    }
  }, 15_000);

  test("disconnect() during a connect attempt settles that attempt too", async () => {
    const client = createHiveClient({ ...urls(port()), kind: "player", plays: true, clientId: "abandoned-0001" });
    const attempt = client.connect().then(
      () => "resolved",
      () => "rejected",
    );
    client.disconnect();
    const outcome = await Promise.race([attempt, new Promise<string>((r) => setTimeout(() => r("pending"), 3000))]);
    expect(outcome).toBe("rejected");
    expect(client.connection).toBe("closed");
  }, 10_000);
});
