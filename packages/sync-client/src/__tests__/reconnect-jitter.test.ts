/**
 * ENGINE-SYNC-P4 · the reconnect backoff is jittered.
 *
 * What disconnects one phone usually disconnects all of them (a deploy, the venue router). With a fixed
 * schedule every phone re-JOINs on the same millisecond at every step. Each delay is now spread over
 * +0…50 % of its nominal value — upward only, so no phone reconnects sooner than before.
 *
 * The other half of P4 was the doc mismatch: docs/03 lists 300, 600, 1200, 2400, 4800 ms, and the
 * transport's real sequence has always been 600, 1200, 2400, 4800, 4800 (it counts its first retry as
 * attempt 1). That timing is kept and the comment corrected, not the other way round: a 300 ms first
 * retry was tried, and it made the reconnect banner too brief for the e2e that waits for it
 * (host-restart) and landed re-JOINs inside the AUDIO_READY rate guard (ENGINE-SYNC-23).
 */
import { describe, expect, test } from "bun:test";
import { createHiveClient, jitteredReconnectDelayMs, reconnectDelayMs } from "../index";
import { nullAudioEngine } from "../client";
import { RECONNECT_JITTER } from "../transport";
import { rng } from "./sim";
import { startRecordingServer, waitFor } from "./recording-server";

describe("ENGINE-SYNC-P4 · reconnect backoff", () => {
  test("the nominal schedule is unchanged: 300, 600, 1200, 2400, 4800, then flat", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([300, 600, 1200, 2400, 4800, 4800, 4800]);
  });

  test("the jittered delay is never shorter than nominal, at most 50 % longer, and actually spreads", () => {
    const rand = rng(7);
    for (let attempt = 0; attempt < 8; attempt++) {
      const nominal = reconnectDelayMs(attempt);
      const draws = Array.from({ length: 500 }, () => jitteredReconnectDelayMs(attempt, rand));
      expect(Math.min(...draws)).toBeGreaterThanOrEqual(nominal);
      expect(Math.max(...draws)).toBeLessThanOrEqual(nominal * (1 + RECONNECT_JITTER));
      // spread: both ends of the range are reached
      expect(Math.max(...draws) - Math.min(...draws)).toBeGreaterThan(nominal * RECONNECT_JITTER * 0.9);
    }
    expect(jitteredReconnectDelayMs(1, () => 0)).toBe(600);
    expect(jitteredReconnectDelayMs(1, () => 1)).toBe(900);
  });

  test("on the wire: the first re-JOIN comes 600–900 ms after the drop, and thirty phones do not come back together", async () => {
    const server = startRecordingServer();
    const clients = Array.from({ length: 30 }, (_, i) =>
      createHiveClient(
        { ...server.urls, kind: "player", plays: true, clientId: `jitter-play-${String(i).padStart(4, "0")}` },
        { createAudioEngine: () => nullAudioEngine() },
      ),
    );
    try {
      await Promise.all(clients.map((c) => c.connect()));
      expect(server.joins).toHaveLength(30);
      const arrivals: number[] = [];
      const seen = new Set<string>();
      const droppedAt = performance.now();
      server.dropAll();
      await waitFor(() => {
        for (const j of server.joins.slice(30)) {
          if (!seen.has(j.clientId)) {
            seen.add(j.clientId);
            arrivals.push(performance.now() - droppedAt);
          }
        }
        return seen.size === 30;
      }, "all thirty to come back");
      arrivals.sort((a, b) => a - b);
      // (polling adds up to 15 ms; the close itself takes a few)
      expect(arrivals[0]!).toBeGreaterThanOrEqual(590);
      expect(arrivals[29]!).toBeLessThan(1000);
      // spread over most of the 300 ms window instead of one instant
      expect(arrivals[29]! - arrivals[0]!).toBeGreaterThan(120);
    } finally {
      for (const c of clients) c.disconnect();
      server.stop();
    }
  }, 20_000);
});
