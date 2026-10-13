/**
 * RT-02 · `libraryKey` pass-through (contract: D:\HiveMusic-audit\contracts\library-scope.md).
 *
 * A host's browser keeps a secret that says whose uploads its hives may see. The engine's whole part:
 * put it in JOIN when — and only when — this client is a host, on the first join and every reconnect,
 * and nowhere else. It is a bearer secret, so nothing may log it or surface it.
 */
import { describe, expect, test } from "bun:test";
import { createHiveClient, createStubClient } from "../index";
import { nullAudioEngine } from "../client";
import { startRecordingServer, waitFor } from "./recording-server";

const KEY = "lib-key-0123456789abcdefghijklmnopqrstuvwxyz"; // 44 chars, the shape the web app makes
const builders = {
  "real client": (o: Parameters<typeof createHiveClient>[0]) => createHiveClient(o, { createAudioEngine: () => nullAudioEngine() }),
  "stub client": (o: Parameters<typeof createStubClient>[0]) => createStubClient(o),
};

for (const [name, build] of Object.entries(builders)) {
  describe(`RT-02 · libraryKey in JOIN (${name})`, () => {
    test("a host sends it in the first JOIN and in every re-JOIN", async () => {
      const server = startRecordingServer();
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", libraryKey: KEY, clientId: "lib-host-00001" });
      try {
        await host.connect();
        server.dropAll();
        await waitFor(() => server.joins.length === 2, "the re-JOIN");
        server.dropAll();
        await waitFor(() => server.joins.length === 3, "the second re-JOIN");
        expect(server.joins.map((j) => j.libraryKey)).toEqual([KEY, KEY, KEY]);
      } finally {
        host.disconnect();
        server.stop();
      }
    }, 20_000);

    test("a player or a viewer with the option set (a caller mistake) never sends it", async () => {
      const server = startRecordingServer();
      const player = build({ ...server.urls, kind: "player", plays: true, libraryKey: KEY, clientId: "lib-play-00001" });
      const viewer = build({ ...server.urls, kind: "viewer", plays: false, libraryKey: KEY, clientId: "lib-view-00001" });
      try {
        await Promise.all([player.connect(), viewer.connect()]);
        server.dropAll();
        await waitFor(() => server.joins.length === 4, "both re-JOINs");
        for (const j of server.joins) {
          expect("libraryKey" in j).toBe(false);
          expect(j.raw).not.toContain(KEY);
        }
      } finally {
        player.disconnect();
        viewer.disconnect();
        server.stop();
      }
    }, 20_000);

    test("a host without one, or with one the wire schema would refuse, still joins — without the field", async () => {
      const server = startRecordingServer();
      const none = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", clientId: "lib-host-00002" });
      const short = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", libraryKey: "too-short", clientId: "lib-host-00003" });
      const long = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", libraryKey: "x".repeat(65), clientId: "lib-host-00004" });
      try {
        await Promise.all([none.connect(), short.connect(), long.connect()]);
        expect(server.joins).toHaveLength(3);
        for (const j of server.joins) expect("libraryKey" in j).toBe(false);
      } finally {
        none.disconnect();
        short.disconnect();
        long.disconnect();
        server.stop();
      }
    });

    test("the key appears in nothing else the client sends, shows or logs", async () => {
      const server = startRecordingServer();
      const logged: string[] = [];
      const methods = ["log", "info", "warn", "error", "debug"] as const;
      const saved = methods.map((m) => console[m]);
      methods.forEach((m) => {
        console[m] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
      });
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", libraryKey: KEY, clientId: "lib-host-00005" });
      try {
        await host.connect();
        await host.host.vibe("x").catch(() => {});
        host.host.setMode("UNISON");
        host.host.setPlays(true);
        await new Promise((r) => setTimeout(r, 2300)); // long enough for probes and a CLIENT_STATUS
        const everythingButJoin = server.frames.filter((f) => !f.includes('"type":"JOIN"'));
        expect(everythingButJoin.length).toBeGreaterThan(3);
        for (const f of everythingButJoin) expect(f).not.toContain(KEY);
        expect(JSON.stringify(server.vibes)).not.toContain(KEY);
        expect(JSON.stringify(host.status)).not.toContain(KEY);
        expect(JSON.stringify((host.audio as unknown as { debug?: unknown }).debug ?? {})).not.toContain(KEY);
        expect(logged.join("\n")).not.toContain(KEY);
      } finally {
        methods.forEach((m, i) => (console[m] = saved[i]!));
        host.disconnect();
        server.stop();
      }
    }, 15_000);
  });
}
