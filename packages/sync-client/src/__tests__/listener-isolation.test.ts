/**
 * ENGINE-SYNC-13 · a UI listener that throws, and a ROOM_STATE for a room this client did not join.
 */
import { describe, expect, test } from "bun:test";
import { startMockServer } from "@hive/protocol/mock-server";
import type { Assignment, RoomState } from "@hive/protocol";
import { createHiveClient } from "../index";
import { nullAudioEngine, type AudioEngine } from "../client";
import { Emitter } from "../transport";

const port = (): number => 17000 + Math.floor(Math.random() * 900);
const urls = (p: number) => ({ wsUrl: `ws://localhost:${p}/ws`, apiUrl: `http://localhost:${p}`, roomCode: "BZQ7" });
const waitFor = async (pred: () => boolean, what: string, timeoutMs = 6000) => {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** An audio engine that records what the client hands it and plays nothing. */
function recordingEngine() {
  const applied: Array<{ code: string; assignment: Assignment | null }> = [];
  const engine: AudioEngine = {
    ...nullAudioEngine(),
    applyRoom: (room: RoomState, assignment: Assignment | null) => void applied.push({ code: room.code, assignment }),
  };
  return { engine, applied };
}

describe("ENGINE-SYNC-13 · one bad listener, one stray snapshot", () => {
  test("Emitter: a listener that throws does not stop the listeners after it, or the emitter's caller", () => {
    const ev = new Emitter();
    const seen: string[] = [];
    const quiet = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      ev.on("connection", () => seen.push("first"));
      ev.on("connection", () => {
        throw new Error("a bug in a UI handler");
      });
      ev.on("connection", () => seen.push("third"));
      expect(() => ev.emit("connection", "open", null)).not.toThrow();
    } finally {
      console.error = quiet;
    }
    expect(seen).toEqual(["first", "third"]);
    expect(logged).toHaveLength(1); // reported, not swallowed
  });

  test("a throwing 'state' listener does not keep the snapshot from the audio engine", async () => {
    const p = port();
    const mock = startMockServer({ port: p, quiet: true, scenario: { players: [] } });
    await mock.ready;
    const { engine, applied } = recordingEngine();
    const client = createHiveClient(
      { ...urls(p), kind: "player", plays: true, clientId: "bad-listener-0001" },
      { createAudioEngine: () => engine },
    );
    const quiet = console.error;
    console.error = () => {};
    try {
      client.on("state", () => {
        throw new Error("render blew up");
      });
      await client.connect();
      await waitFor(() => applied.length > 0, "the engine to receive a snapshot");
      expect(applied[0]!.code).toBe("BZQ7");
    } finally {
      console.error = quiet;
      client.disconnect();
      mock.stop();
    }
  }, 10_000);

  test("a ROOM_STATE for a different room code never reaches the engine", async () => {
    // First borrow a schema-valid snapshot from the mock…
    const p1 = port();
    const mock = startMockServer({ port: p1, quiet: true, scenario: { players: [] } });
    await mock.ready;
    const probe = createHiveClient({ ...urls(p1), kind: "player", plays: true, clientId: "stray-room-0001" });
    await probe.connect();
    await waitFor(() => probe.room !== null, "a snapshot to borrow");
    const real = structuredClone(probe.room!);
    probe.disconnect();
    mock.stop();

    // …then serve it from a server that answers JOIN with someone else's room first, then the right one.
    const p2 = port() + 1000;
    const server = Bun.serve({
      port: p2,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response("ws only", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type !== "JOIN") return;
          ws.send(JSON.stringify({ type: "WELCOME", clientId: "stray-room-0001", roomCode: "BZQ7", serverTime: Date.now(), protocolVersion: real.protocolVersion, isHost: false }));
          ws.send(JSON.stringify({ type: "ROOM_STATE", room: { ...real, code: "ZZZZ" } }));
          ws.send(JSON.stringify({ type: "ROOM_STATE", room: real }));
        },
      },
    });
    const { engine, applied } = recordingEngine();
    const client = createHiveClient(
      { ...urls(p2), kind: "player", plays: true, clientId: "stray-room-0001" },
      { createAudioEngine: () => engine },
    );
    const states: string[] = [];
    client.on("state", (r) => states.push(r.code));
    try {
      await client.connect();
      await waitFor(() => applied.length > 0, "the right snapshot");
      expect(applied.map((a) => a.code)).toEqual(["BZQ7"]);
      expect(states).toEqual(["BZQ7"]);
      expect(client.room!.code).toBe("BZQ7");
    } finally {
      client.disconnect();
      server.stop(true);
    }
  }, 15_000);
});
