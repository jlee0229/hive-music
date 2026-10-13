/**
 * SG-09 · `host.vibe()` sends the host key as `Authorization: Bearer`, from the real client and the stub.
 *
 * The server accepts the key there now, so the endpoint can be locked to hosts (red-team will turn
 * `VIBE_REQUIRE_HOST_KEY` on). Two things have to hold for that: both clients send it, and a client
 * without a key gets an error it can show — not a promise that resolves with nothing.
 */
import { describe, expect, test } from "bun:test";
import { createHiveClient, createStubClient } from "../index";
import { nullAudioEngine } from "../client";
import { startRecordingServer } from "./recording-server";

const builders = {
  "real client": (o: Parameters<typeof createHiveClient>[0]) => createHiveClient(o, { createAudioEngine: () => nullAudioEngine() }),
  "stub client": (o: Parameters<typeof createStubClient>[0]) => createStubClient(o),
};

for (const [name, build] of Object.entries(builders)) {
  describe(`SG-09 · vibe authorisation (${name})`, () => {
    test("the host key travels as a Bearer token; the body is unchanged", async () => {
      const server = startRecordingServer();
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "host-key-abc123", clientId: "vibe-host-0001" });
      try {
        const plan = await host.host.vibe("calm, then explode");
        expect(plan.scenes.length).toBeGreaterThan(0);
        expect(server.vibes).toHaveLength(1);
        expect(server.vibes[0]!.authorization).toBe("Bearer host-key-abc123");
        expect(server.vibes[0]!.contentType).toContain("application/json");
        expect(server.vibes[0]!.body).toEqual({ prompt: "calm, then explode" });
      } finally {
        host.disconnect();
        server.stop();
      }
    });

    test("without a key no Authorization header is invented, and a refusal is a clear error", async () => {
      const server = startRecordingServer({ vibeStatus: 401 });
      const keyless = build({ ...server.urls, kind: "host", plays: false, clientId: "vibe-host-0002" });
      const wrongKey = build({ ...server.urls, kind: "host", plays: false, hostKey: "stale", clientId: "vibe-host-0003" });
      try {
        const noKey = await keyless.host.vibe("anything").then(
          () => null,
          (e: Error & { status?: number }) => e,
        );
        expect(noKey).not.toBeNull();
        expect(noKey!.message).toBe("vibe failed: 401 (this client has no host key)");
        expect(noKey!.status).toBe(401);
        expect(server.vibes[0]!.authorization).toBeNull();

        const bad = await wrongKey.host.vibe("anything").then(
          () => null,
          (e: Error & { status?: number }) => e,
        );
        expect(bad!.message).toBe("vibe failed: 401 (the server did not accept this host key)");
        expect(server.vibes[1]!.authorization).toBe("Bearer stale");
      } finally {
        keyless.disconnect();
        wrongKey.disconnect();
        server.stop();
      }
    });

    test("other failures keep their status", async () => {
      const server = startRecordingServer({ vibeStatus: 404 });
      const host = build({ ...server.urls, kind: "host", plays: false, hostKey: "k", clientId: "vibe-host-0004" });
      try {
        await expect(host.host.vibe("x")).rejects.toThrow("vibe failed: 404 (the request was refused)");
      } finally {
        host.disconnect();
        server.stop();
      }
    });
  });
}
