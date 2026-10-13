/**
 * HOST-06, root cause · a host's re-JOIN says what the host last chose, not what the client was built with.
 *
 * "This phone plays music too" is sent as SET_PLAYS; the server also takes a host's `plays` from every
 * JOIN. The transport re-JOINed after each dropped socket with the creation-time option (false), so any
 * Wi-Fi blip switched the host's own speaker off while the page's toggle stayed ticked. host-ui worked
 * around it in the page (5ef1209: re-send SET_PLAYS when the room disagrees); with this the JOIN itself
 * is right and that workaround has nothing left to correct.
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
  describe(`HOST-06 · plays across a reconnect (${name})`, () => {
    test("after setPlays(true), every re-JOIN carries plays: true; after setPlays(false), false again", async () => {
      const server = startRecordingServer();
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", clientId: "plays-host-0001" });
      try {
        await host.connect();
        expect(server.joins.map((j) => j.plays)).toEqual([false]);

        host.host.setPlays(true); // the toggle is ticked
        await waitFor(() => server.frames.some((f) => f.includes('"SET_PLAYS"')), "SET_PLAYS on the wire");
        server.dropAll(); // a Wi-Fi blip
        await waitFor(() => server.joins.length === 2, "the re-JOIN");
        expect(server.joins[1]!.plays).toBe(true);

        server.dropAll(); // and another
        await waitFor(() => server.joins.length === 3, "the second re-JOIN");
        expect(server.joins[2]!.plays).toBe(true);

        host.host.setPlays(false);
        server.dropAll();
        await waitFor(() => server.joins.length === 4, "the third re-JOIN");
        expect(server.joins[3]!.plays).toBe(false);
      } finally {
        host.disconnect();
        server.stop();
      }
    }, 30_000);

    test("a player is always a speaker, whatever its options say", async () => {
      const server = startRecordingServer();
      const player = build({ ...server.urls, kind: "player", plays: false, clientId: "plays-play-0001" });
      try {
        await player.connect();
        server.dropAll();
        await waitFor(() => server.joins.length === 2, "the re-JOIN");
        expect(server.joins.map((j) => j.plays)).toEqual([true, true]);
      } finally {
        player.disconnect();
        server.stop();
      }
    }, 15_000);
  });
}
