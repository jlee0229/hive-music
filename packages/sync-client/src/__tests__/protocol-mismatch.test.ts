/**
 * PROTO-13 · a WELCOME from a server on another protocol version is surfaced, not ignored.
 *
 * The page-load guard only runs at page load. A tab that was open when the server was deployed
 * reconnects and carries on with a bundle the server no longer matches — and nothing read
 * `WELCOME.protocolVersion`. The engine now reports it (event + property) on every WELCOME; it never
 * reloads anything itself.
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@hive/protocol";
import { createHiveClient, createStubClient } from "../index";
import { nullAudioEngine } from "../client";
import { startRecordingServer, waitFor } from "./recording-server";

const builders = {
  "real client": (o: Parameters<typeof createHiveClient>[0]) => createHiveClient(o, { createAudioEngine: () => nullAudioEngine() }),
  "stub client": (o: Parameters<typeof createStubClient>[0]) => createStubClient(o),
};

for (const [name, build] of Object.entries(builders)) {
  describe(`PROTO-13 · protocol version skew (${name})`, () => {
    test("a matching server: no event, nothing set", async () => {
      const server = startRecordingServer();
      const client = build({ ...server.urls, kind: "player", plays: true, clientId: "skew-same-0001" });
      const seen: number[][] = [];
      client.on("protocolMismatch", (s, c) => seen.push([s, c]));
      try {
        await client.connect();
        expect(client.protocolMismatch).toBeNull();
        expect(seen).toEqual([]);
      } finally {
        client.disconnect();
        server.stop();
      }
    });

    test("a tab left open across a deploy: the reconnect's WELCOME reports the new version, and connecting still works", async () => {
      let version: number = PROTOCOL_VERSION;
      const server = startRecordingServer({ protocolVersion: () => version });
      const client = build({ ...server.urls, kind: "player", plays: true, clientId: "skew-open-0001" });
      const seen: number[][] = [];
      client.on("protocolMismatch", (s, c) => seen.push([s, c]));
      try {
        await client.connect();
        expect(seen).toEqual([]);

        version = PROTOCOL_VERSION + 1; // the server is redeployed…
        server.dropAll(); // …which drops every socket
        await waitFor(() => server.joins.length === 2 && client.connection === "open", "the re-JOIN");
        await waitFor(() => seen.length === 1, "the mismatch event");
        expect(seen[0]).toEqual([PROTOCOL_VERSION + 1, PROTOCOL_VERSION]);
        expect(client.protocolMismatch).toEqual({ server: PROTOCOL_VERSION + 1, client: PROTOCOL_VERSION });
        expect(client.connection).toBe("open"); // reported, not acted on: the page decides

        version = PROTOCOL_VERSION; // rolled back: the flag clears on the next WELCOME
        server.dropAll();
        await waitFor(() => server.joins.length === 3 && client.connection === "open", "the second re-JOIN");
        await waitFor(() => client.protocolMismatch === null, "the flag to clear");
        expect(seen).toHaveLength(1);
      } finally {
        client.disconnect();
        server.stop();
      }
    }, 20_000);
  });
}
