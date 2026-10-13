/**
 * ENGINE-SYNC-P4 · the reconnect backoff is jittered, and its first step is the documented 300 ms.
 *
 * What disconnects one phone usually disconnects all of them (a deploy, the venue router). With a fixed
 * schedule every phone re-JOINs on the same millisecond at every step. And the transport passed its
 * already-incremented attempt counter to `reconnectDelayMs`, so the real sequence was 600, 1200, 2400,
 * 4800, 5000 — not the 300, 600, 1200, 2400, 4800 the function and docs/03 describe.
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

  test("the jittered delay stays within ±25 % of nominal and actually spreads", () => {
    const rand = rng(7);
    for (let attempt = 0; attempt < 8; attempt++) {
      const nominal = reconnectDelayMs(attempt);
      const draws = Array.from({ length: 500 }, () => jitteredReconnectDelayMs(attempt, rand));
      expect(Math.min(...draws)).toBeGreaterThanOrEqual(nominal * (1 - RECONNECT_JITTER));
      expect(Math.max(...draws)).toBeLessThanOrEqual(nominal * (1 + RECONNECT_JITTER));
      // spread: the two ends of the range are both reached, and the mean is the nominal value
      expect(Math.max(...draws) - Math.min(...draws)).toBeGreaterThan(nominal * RECONNECT_JITTER * 1.8);
      expect(Math.abs(draws.reduce((a, b) => a + b, 0) / draws.length - nominal)).toBeLessThan(nominal * 0.03);
    }
    expect(jitteredReconnectDelayMs(0, () => 0)).toBe(225);
    expect(jitteredReconnectDelayMs(0, () => 1)).toBe(375);
  });

  test("on the wire: the first re-JOIN comes 225–375 ms after the drop, and thirty phones do not come back together", async () => {
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
      expect(arrivals[0]!).toBeGreaterThanOrEqual(215);
      expect(arrivals[29]!).toBeLessThan(450);
      // spread over most of the 150 ms window instead of one instant
      expect(arrivals[29]! - arrivals[0]!).toBeGreaterThan(60);
    } finally {
      for (const c of clients) c.disconnect();
      server.stop();
    }
  }, 20_000);
});
