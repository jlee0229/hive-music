import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * Regression tests for a demo-risk review of the room manager (docs/PROTOCOL-REQUESTS.md — filed as
 * P0-2 and P0-4). Both are real bugs a fixed-code demo room can hit mid-event: a Fly restart or the
 * room's idle timeout re-spawns the ROOM_FIXED_CODE room with a fresh hostKey, and a flaky Wi-Fi
 * reconnect can leave two sockets briefly registered for the same clientId.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

function fakeServer() {
  const published: ServerMessage[] = [];
  const server = { publish: (_topic: string, data: string) => published.push(JSON.parse(data)) } as unknown as Bun.Server<Conn>;
  return { server, published };
}
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}

describe("P0-2: host re-join after the fixed-code room is re-spawned", () => {
  test("create room, host joins, the room is destroyed and re-spawned (simulating a restart) — the host still becomes host with a stale key", () => {
    const { server } = fakeServer();
    const room1 = new Room("P0A", server, () => {}, () => []);
    const hostWs1 = fakeWs();
    room1.join(hostWs1.ws, { type: "JOIN", clientId: "host-p0a-01", roomCode: "P0A", kind: "host", plays: false, hostKey: room1.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    expect(room1.room.clients["host-p0a-01"]!.kind).toBe("host");
    expect(room1.room.hostClientIds).toContain("host-p0a-01");
    const staleHostKey = room1.hostKey;
    room1.destroy(); // e.g. ROOM_IDLE_TTL_MS elapsed, or a restart

    // re-spawned with the same code but a brand-new (different) hostKey — nobody holds it yet
    const room2 = new Room("P0A", server, () => {}, () => []);
    expect(room2.hostKey).not.toBe(staleHostKey);
    const hostWs2 = fakeWs();
    room2.join(hostWs2.ws, { type: "JOIN", clientId: "host-p0a-01", roomCode: "P0A", kind: "host", plays: false, hostKey: staleHostKey, device, protocolVersion: PROTOCOL_VERSION });

    expect(room2.room.clients["host-p0a-01"]!.kind).toBe("host");
    expect(room2.room.hostClientIds).toContain("host-p0a-01");
    const welcome = hostWs2.sent.find((m) => m.type === "WELCOME");
    expect(welcome?.type === "WELCOME" && welcome.isHost).toBe(true);

    room2.destroy();
  });

  test("a second host claiming kind:'host' with the wrong key is refused once someone already holds the room", () => {
    const { server } = fakeServer();
    const room = new Room("P0A2", server, () => {}, () => []);
    const host1 = fakeWs();
    room.join(host1.ws, { type: "JOIN", clientId: "host-p0a2-01", roomCode: "P0A2", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });

    const impostor = fakeWs();
    room.join(impostor.ws, { type: "JOIN", clientId: "player-p0a2-02", roomCode: "P0A2", kind: "host", plays: false, hostKey: "wrong-key", device, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["player-p0a2-02"]!.kind).toBe("player"); // hostClientIds is non-empty, so the "nobody holds it" clause doesn't apply
    expect(room.room.hostClientIds).toEqual(["host-p0a2-01"]);

    room.destroy();
  });

  test("an existing player record is promoted to host once it presents the room's real hostKey", () => {
    const { server } = fakeServer();
    const room = new Room("P0A3", server, () => {}, () => []);
    const host = fakeWs();
    room.join(host.ws, { type: "JOIN", clientId: "host-p0a3-01", roomCode: "P0A3", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const p1 = fakeWs();
    // joins as a plain player first (e.g. it was demoted by this exact bug before the fix)
    room.join(p1.ws, { type: "JOIN", clientId: "demoted-host-01", roomCode: "P0A3", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["demoted-host-01"]!.kind).toBe("player");

    const p1b = fakeWs();
    room.join(p1b.ws, { type: "JOIN", clientId: "demoted-host-01", roomCode: "P0A3", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["demoted-host-01"]!.kind).toBe("host");
    expect(room.room.hostClientIds).toContain("demoted-host-01");

    room.destroy();
  });
});

describe("P0-4: a stale socket's close must not demote the live one", () => {
  test("join with socket A, reconnect the same clientId with socket B, close A — client stays connected and B still gets broadcasts", () => {
    const { server, published } = fakeServer();
    const room = new Room("P0B", server, () => {}, () => []);
    const wsA = fakeWs();
    room.join(wsA.ws, { type: "JOIN", clientId: "play-p0b-01", roomCode: "P0B", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["play-p0b-01"]!.connected).toBe(true);

    const wsB = fakeWs();
    room.join(wsB.ws, { type: "JOIN", clientId: "play-p0b-01", roomCode: "P0B", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect(room.room.clients["play-p0b-01"]!.connected).toBe(true);

    const publishedBefore = published.length;
    room.disconnect(wsA.ws); // A's close event arrives late, after B already took over
    expect(room.room.clients["play-p0b-01"]!.connected).toBe(true); // still connected via B
    expect(published.length).toBe(publishedBefore); // no spurious "disconnected" broadcast either

    // B receives further broadcasts (it is still the registered socket for this clientId)
    room.handle(wsA.ws, { type: "SET_PLAYS", plays: false }); // stray message from the dead socket: no-op, not host
    expect(room.room.clients["play-p0b-01"]!.connected).toBe(true);

    room.disconnect(wsB.ws); // the real disconnect
    expect(room.room.clients["play-p0b-01"]!.connected).toBe(false);

    room.destroy();
  });
});

describe("P2-11: a SET_MODE tapped while a vibe request is in flight is not clobbered", () => {
  test("acceptScenePlan drops a plan whose modeVersion is stale, and applies one that still matches", () => {
    const { server } = fakeServer();
    const room = new Room("P2B", server, () => {}, () => []);
    const host = fakeWs();
    room.join(host.ws, { type: "JOIN", clientId: "host-p2b-01", roomCode: "P2B", kind: "host", plays: false, hostKey: room.hostKey, device, protocolVersion: PROTOCOL_VERSION });

    const requestModeVersion = room.getModeVersion();
    // the host taps a mode chip while a (slow) vibe request using the snapshot above is still in flight
    room.handle(host.ws, { type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    expect(room.room.mode.kind).toBe("ORCHESTRA");

    const stalePlan = { prompt: "p", source: "rules" as const, createdAtServerTime: 0, scenes: [{ atTrackSec: 0, mode: "STROBE" as const, params: {}, note: "n" }] };
    const applied = room.acceptScenePlan(stalePlan, requestModeVersion);
    expect(applied).toBe(false);
    expect(room.room.mode.kind).toBe("ORCHESTRA"); // the host's manual choice survives
    expect(room.room.scenePlan).toBeNull();

    // a second request started fresh (current version) still lands normally
    const freshPlan = { ...stalePlan, prompt: "p2" };
    const applied2 = room.acceptScenePlan(freshPlan, room.getModeVersion());
    expect(applied2).toBe(true);
    expect(room.room.scenePlan?.prompt).toBe("p2");

    room.destroy();
  });
});

describe("P2-10: userAgent is never stored or broadcast", () => {
  test("a JOIN carrying a long real userAgent string ends up empty in the room's client record", () => {
    const { server } = fakeServer();
    const room = new Room("P2A", server, () => {}, () => []);
    const ws = fakeWs();
    const realDevice = { ...device, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" };
    room.join(ws.ws, { type: "JOIN", clientId: "play-p2a-01", roomCode: "P2A", kind: "player", plays: true, device: realDevice, protocolVersion: PROTOCOL_VERSION });

    expect(room.room.clients["play-p2a-01"]!.device.userAgent).toBe("");
    expect(room.room.clients["play-p2a-01"]!.device.browserFamily).toBe(realDevice.browserFamily); // everything else survives
    expect(room.room.clients["play-p2a-01"]!.tableLatencyMs).not.toBeUndefined(); // browserFamily lookup still works

    room.destroy();
  });
});
