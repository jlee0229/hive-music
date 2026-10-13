/**
 * `client.isHost` — what the server's WELCOME said about this socket.
 *
 * The server answers a host JOIN that carries a wrong or missing key with `WELCOME isHost:false`, and if
 * the clientId is the host's own it seats the socket as a read-only observer whose `me` is the *host's*
 * record. `room.hostClientIds` cannot tell that seat from the real one; WELCOME can. The engine exposes it
 * as a property and as the second argument of the `connection` event, already up to date at "open".
 */
import { describe, expect, test } from "bun:test";
import { createHiveClient, createStubClient } from "../index";
import { nullAudioEngine } from "../client";
import { startRecordingServer, waitFor } from "./recording-server";

const builders = {
  "real client": (o: Parameters<typeof createHiveClient>[0]) => createHiveClient(o, { createAudioEngine: () => nullAudioEngine() }),
  "stub client": (o: Parameters<typeof createStubClient>[0]) => createStubClient(o),
};

for (const [name, build] of Object.entries(builders)) {
  describe(`WELCOME.isHost (${name})`, () => {
    test("null before the first WELCOME; true for a host the server accepts, false for a player", async () => {
      const server = startRecordingServer();
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "right", clientId: "ishost-host-0001" });
      const player = build({ ...server.urls, kind: "player", plays: true, clientId: "ishost-play-0001" });
      const seen: Array<[string, boolean | null]> = [];
      host.on("connection", (state, isHost) => seen.push([state, isHost]));
      try {
        expect(host.isHost).toBeNull();
        expect(player.isHost).toBeNull();
        await Promise.all([host.connect(), player.connect()]);
        expect(host.isHost).toBe(true);
        expect(player.isHost).toBe(false);
        // "connecting" is announced before anything is known; "open" already carries the answer
        expect(seen).toEqual([["connecting", null], ["open", true]]);
      } finally {
        host.disconnect();
        player.disconnect();
        server.stop();
      }
    });

    test("a host JOIN the server does not accept (wrong or missing key) reads false, not 'host by roster'", async () => {
      const server = startRecordingServer({ isHost: (join) => join.hostKey === "right" });
      const wrong = build({ ...server.urls, kind: "host", plays: false, hostKey: "stale", clientId: "ishost-host-0002" });
      const none = build({ ...server.urls, kind: "host", plays: false, clientId: "ishost-host-0003" });
      const events: Array<boolean | null> = [];
      wrong.on("connection", (state, isHost) => state === "open" && events.push(isHost));
      try {
        await Promise.all([wrong.connect(), none.connect()]);
        expect(wrong.isHost).toBe(false);
        expect(none.isHost).toBe(false);
        expect(events).toEqual([false]);
        expect(wrong.connection).toBe("open"); // seated (as an observer), just not as a host
      } finally {
        wrong.disconnect();
        none.disconnect();
        server.stop();
      }
    });

    test("it follows every WELCOME: true, then false after the room came back under another key, then true again", async () => {
      let key = "first";
      const server = startRecordingServer({ isHost: (join) => join.hostKey === key });
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "first", clientId: "ishost-host-0004" });
      const opens: Array<boolean | null> = [];
      host.on("connection", (state, isHost) => state === "open" && opens.push(isHost));
      try {
        await host.connect();
        expect(host.isHost).toBe(true);

        key = "second"; // the room was re-created under a new key while this tab was away
        server.dropAll();
        await waitFor(() => opens.length === 2, "the reconnect");
        expect(host.isHost).toBe(false);

        key = "first";
        server.dropAll();
        await waitFor(() => opens.length === 3, "the second reconnect");
        expect(host.isHost).toBe(true);
        expect(opens).toEqual([true, false, true]);
        // while reconnecting, the last known answer is still what the property says
        expect(host.connection).toBe("open");
      } finally {
        host.disconnect();
        server.stop();
      }
    }, 20_000);
  });
}
