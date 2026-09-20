import { describe, expect, test } from "bun:test";
import { LEAD_MS, PROTOCOL_VERSION } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
const fakeWs = () => ({ data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} }) as unknown as WS;
// A very short track so the loop boundary arrives inside a test run: end = zero + 800 ms,
// and the loop timer fires LEAD_MS (600) before it, i.e. ~200 ms after PLAY.
const shortLibrary = () => [{ id: "t", title: "t", durationSec: 0.8, stems: ["mix"], urls: {} }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function playingRoom() {
  const room = new Room("LOOP", fakeServer(), () => {}, shortLibrary);
  const host = fakeWs();
  room.join(host, { type: "JOIN", clientId: "host-loop-h01", roomCode: "LOOP", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
  room.handle(host, { type: "SET_TRACK", trackId: "t" });
  return { room, host };
}

describe("end-of-track loop (the room used to go silent forever)", () => {
  test("the track restarts seamlessly at its own end: new zero === old end, still playing", async () => {
    const { room, host } = playingRoom();
    room.handle(host, { type: "TRANSPORT", action: "PLAY" });
    const t = room.room.transport;
    expect(t.state).toBe("playing");
    const zero0 = t.state === "playing" ? t.serverTimeAtTrackZero : NaN;
    const end0 = zero0 + 0.8 * 1000;

    await sleep(800); // loop fires at end0 − LEAD_MS ≈ 200 ms in; well past it by now
    const t1 = room.room.transport;
    expect(t1.state).toBe("playing");
    const zero1 = t1.state === "playing" ? t1.serverTimeAtTrackZero : NaN;
    expect(zero1).not.toBe(zero0);
    // Seamless: the new track zero is exactly the old boundary (fired LEAD_MS early, boundary was ahead).
    expect(Math.abs(zero1 - end0)).toBeLessThanOrEqual(1);

    room.destroy();
  });

  test("PAUSE before the boundary cancels the loop; the room stays paused past the end", async () => {
    const { room, host } = playingRoom();
    room.handle(host, { type: "TRANSPORT", action: "PLAY" });
    room.handle(host, { type: "TRANSPORT", action: "PAUSE" });
    expect(room.room.transport.state).toBe("paused");

    await sleep(900);
    expect(room.room.transport.state).toBe("paused");

    room.destroy();
  });

  test("a boundary already in the past restarts with the standard lead instead of a zero in the past", async () => {
    const { room, host } = playingRoom();
    // SEEK far beyond the 0.8 s track: the armed timer fires immediately with the end long gone.
    room.handle(host, { type: "TRANSPORT", action: "PLAY", trackTimeSec: 30 });
    await sleep(150);
    const t = room.room.transport;
    expect(t.state).toBe("playing");
    if (t.state === "playing") {
      // zero is in the future (≈ now + LEAD_MS): the restart begins at 0:00, not mid-track.
      expect(t.serverTimeAtTrackZero).toBeGreaterThan(Date.now() - 5);
    }
    room.destroy();
  });
});

describe("playlist auto-advance at the end of a song", () => {
  const twoSongLibrary = () => [
    { id: "song-a", title: "Song A", durationSec: 0.8, stems: ["mix"], urls: {} },
    { id: "song-b", title: "Song B", durationSec: 30, stems: ["mix"], urls: {} },
    { id: "synth", title: "Synthetic", durationSec: 60, stems: ["mix"], urls: {}, generated: true },
  ];

  test("with more real songs in the library, the room advances to the next one (skipping generated)", async () => {
    const room = new Room("ADV1", fakeServer(), () => {}, twoSongLibrary);
    const host = fakeWs();
    room.join(host, { type: "JOIN", clientId: "host-adv-h001", roomCode: "ADV1", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(host, { type: "SET_TRACK", trackId: "song-a" });
    room.handle(host, { type: "TRANSPORT", action: "PLAY" });
    const t0 = room.room.transport;
    const end0 = (t0.state === "playing" ? t0.serverTimeAtTrackZero : NaN) + 0.8 * 1000;

    await sleep(800); // the advance fires at end0 − LEAD_MS ≈ 200 ms in
    expect(room.room.track?.id).toBe("song-b");
    const t1 = room.room.transport;
    expect(t1.state).toBe("playing");
    if (t1.state === "playing") {
      // the next song starts after a download breather, never before the old one ended
      expect(t1.serverTimeAtTrackZero).toBeGreaterThanOrEqual(end0 + 4000);
    }
    room.destroy();
  });

  test("a single real song keeps the seamless same-track loop even when generated tracks exist", async () => {
    const oneSongLibrary = () => [
      { id: "only", title: "Only Song", durationSec: 0.8, stems: ["mix"], urls: {} },
      { id: "synth", title: "Synthetic", durationSec: 60, stems: ["mix"], urls: {}, generated: true },
    ];
    const room = new Room("ADV2", fakeServer(), () => {}, oneSongLibrary);
    const host = fakeWs();
    room.join(host, { type: "JOIN", clientId: "host-adv-h002", roomCode: "ADV2", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    room.handle(host, { type: "SET_TRACK", trackId: "only" });
    room.handle(host, { type: "TRANSPORT", action: "PLAY" });
    const t0 = room.room.transport;
    const end0 = (t0.state === "playing" ? t0.serverTimeAtTrackZero : NaN) + 0.8 * 1000;

    await sleep(800);
    expect(room.room.track?.id).toBe("only");
    const t1 = room.room.transport;
    if (t1.state === "playing") expect(Math.abs(t1.serverTimeAtTrackZero - end0)).toBeLessThanOrEqual(1);
    room.destroy();
  });
});

describe("viewer joins stay read-only", () => {
  test("kind viewer is stored as viewer with plays false, gets no assignment, and is not in the calibration order", () => {
    const room = new Room("VIEW", fakeServer(), () => {}, shortLibrary);
    const host = fakeWs();
    room.join(host, { type: "JOIN", clientId: "host-view-h01", roomCode: "VIEW", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p = fakeWs();
    room.join(p, { type: "JOIN", clientId: "play-view-p01", roomCode: "VIEW", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const v = fakeWs();
    room.join(v, { type: "JOIN", clientId: "view-view-v01", roomCode: "VIEW", kind: "viewer", plays: true, device, protocolVersion: PROTOCOL_VERSION });

    const rec = room.room.clients["view-view-v01"]!;
    expect(rec.kind).toBe("viewer");
    expect(rec.plays).toBe(false); // forced, whatever the JOIN claimed
    expect(rec.assignment).toBeNull();
    expect(room.room.hostClientIds).not.toContain("view-view-v01");

    room.handle(host, { type: "SET_TRACK", trackId: "t" });
    room.handle(p, { type: "AUDIO_READY", trackId: "t" });
    room.handle(v, { type: "AUDIO_READY", trackId: "t" });
    room.handle(host, { type: "CALIBRATION_START", referenceClientId: "host-view-h01" });
    expect(room.room.calibration.order).toEqual(["play-view-p01"]);

    room.destroy();
  });
});
