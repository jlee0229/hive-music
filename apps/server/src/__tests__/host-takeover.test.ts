import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * Audit SG-02: becoming host took no key at all in two situations, both reachable by any guest.
 *   a) the room has no host record — true between POST /rooms and the host's first JOIN, and again
 *      DISCONNECT_RETENTION_MS (2 min) after the host's phone locks;
 *   b) the JOIN reuses the host's clientId, which every ROOM_STATE publishes.
 * Host is now granted by the hostKey alone, and checked per socket.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  let closed = false;
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => void (closed = true) } as unknown as WS;
  return { ws, sent, isClosed: () => closed };
}
const library = () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }];
const join = (clientId: string, kind: "host" | "player" | "viewer", hostKey?: string): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: "TAKE",
  kind,
  plays: kind !== "viewer",
  hostKey,
  device,
  protocolVersion: PROTOCOL_VERSION,
});
const errors = (s: { sent: ServerMessage[] }) => s.sent.flatMap((m) => (m.type === "ERROR" ? [m.code] : []));

/** Every host-only message; none of them may change the room when sent by a non-host socket. */
const HOST_ONLY: ClientMessage[] = [
  { type: "SET_TRACK", trackId: "t" },
  { type: "TRANSPORT", action: "PLAY" },
  { type: "SET_MODE", mode: "STROBE", params: {} },
  { type: "ASSIGN", clientId: "real-host-0001", role: "drums" },
  { type: "SET_POSITION", clientId: "real-host-0001", x: 0.1, y: 0.9 },
  { type: "NUDGE", clientId: "real-host-0001", nudgeMs: 50 },
  { type: "SET_PLAYS", plays: true },
  { type: "KICK", clientId: "real-host-0001" },
  { type: "CALIBRATION_START", referenceClientId: "real-host-0001" },
  { type: "CALIBRATION_CANCEL" },
  { type: "CALIBRATION_RESET" },
  { type: "CALIBRATION_REPORT", measurements: [{ clientId: "real-host-0001", residualMs: 40, confidence: 1 }] },
];

describe("SG-02: only the hostKey grants host", () => {
  test("a) a keyless kind:'host' JOIN into a room with no host yet lands as a plain player", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const guest = fakeWs();
    room.join(guest.ws, join("guest-000001", "host"));
    expect(guest.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });
    expect(room.room.clients["guest-000001"]!.kind).toBe("player");
    expect(room.room.hostClientIds).toEqual([]);

    const wrongKey = fakeWs();
    room.join(wrongKey.ws, join("guest-000002", "host", "not-the-key"));
    expect(room.room.clients["guest-000002"]!.kind).toBe("player");

    room.handle(guest.ws, { type: "SET_TRACK", trackId: "t" });
    expect(errors(guest)).toEqual(["NOT_HOST"]);
    expect(room.room.track).toBeNull();

    // the real host arrives later and is the only host
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    expect(room.room.hostClientIds).toEqual(["real-host-0001"]);
    room.destroy();
  });

  test("a) after the host's record is gone, a guest still cannot claim the vacancy", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    room.handle(host.ws, { type: "KICK", clientId: "real-host-0001" }); // fastest way to an empty hostClientIds
    expect(room.room.hostClientIds).toEqual([]);

    const guest = fakeWs();
    room.join(guest.ws, join("guest-000001", "host"));
    expect(room.room.hostClientIds).toEqual([]);
    expect(room.room.clients["guest-000001"]!.kind).toBe("player");
    room.destroy();
  });

  test("b) a JOIN reusing the host's public clientId without the key gets a read-only seat and changes nothing", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
    const before = JSON.stringify(room.room);

    for (const kind of ["player", "host", "viewer"] as const) {
      const impostor = fakeWs();
      room.join(impostor.ws, join("real-host-0001", kind, kind === "host" ? "wrong" : undefined));
      expect(impostor.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });
      expect(impostor.sent.some((m) => m.type === "ROOM_STATE")).toBe(true); // it may watch
      expect(room.sockets.get("real-host-0001")).toBe(host.ws); // …but it did not displace the host's socket

      for (const msg of HOST_ONLY) room.handle(impostor.ws, msg);
      expect(JSON.stringify(room.room)).toBe(before);
      expect(host.isClosed()).toBe(false);

      // its close is not the host's close
      room.disconnect(impostor.ws);
      expect(room.room.clients["real-host-0001"]!.connected).toBe(true);
    }

    // the real host is untouched and still in control
    room.handle(host.ws, { type: "SET_MODE", mode: "STROBE", params: {} });
    expect(room.room.mode.kind).toBe("STROBE");
    expect(errors(host)).toEqual([]);
    room.destroy();
  });

  test("privilege belongs to the socket that showed the key, not to the record", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    // A guest squats an id as a player while there is no host record under it…
    const squatter = fakeWs();
    room.join(squatter.ws, join("shared-id-0001", "player"));
    // …then the host joins under that same id with the key: the RECORD becomes host.
    const host = fakeWs();
    room.join(host.ws, { ...join("shared-id-0001", "host", room.hostKey), plays: false });
    expect(room.room.hostClientIds).toEqual(["shared-id-0001"]);

    // The squatter's socket still says "I am shared-id-0001" but never presented the key.
    room.handle(squatter.ws, { type: "SET_TRACK", trackId: "t" });
    room.handle(squatter.ws, { type: "SET_PLAYS", plays: true });
    expect(errors(squatter)).toEqual(["NOT_HOST"]);
    expect(room.room.track).toBeNull();
    expect(room.room.clients["shared-id-0001"]!.plays).toBe(false);

    room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
    expect(room.room.track?.id).toBe("t");
    room.destroy();
  });

  test("a keyed host reconnect and a keyed promotion still work", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const h1 = fakeWs();
    room.join(h1.ws, join("real-host-0001", "host", room.hostKey));
    room.disconnect(h1.ws);
    const h2 = fakeWs();
    room.join(h2.ws, join("real-host-0001", "host", room.hostKey));
    expect(h2.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: true });
    room.handle(h2.ws, { type: "SET_TRACK", trackId: "t" });
    expect(room.room.track?.id).toBe("t");

    const p = fakeWs();
    room.join(p.ws, join("player-000001", "player"));
    const p2 = fakeWs();
    room.join(p2.ws, join("player-000001", "host", room.hostKey));
    expect(room.room.hostClientIds).toEqual(["real-host-0001", "player-000001"]);
    room.destroy();
  });
});
