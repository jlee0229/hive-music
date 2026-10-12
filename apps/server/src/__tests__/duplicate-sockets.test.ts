import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * Audit SG-03: two live sockets under one clientId. It is not only a reconnect race — every tab of
 * one browser shares `hive:clientId:<room>` (and the host page, the player page and /screen all use
 * that same key). P0-4 made the OLD socket's close harmless; the NEW socket's close still marked the
 * client disconnected and deleted its record DISCONNECT_RETENTION_MS later, with the first tab still
 * open: a host lost control of the room, a player went silent.
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
const join = (room: Room, clientId: string, kind: "host" | "player"): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: room.code,
  kind,
  plays: kind === "player",
  hostKey: kind === "host" ? room.hostKey : undefined,
  device,
  protocolVersion: PROTOCOL_VERSION,
});

describe("SG-03: the newest socket closing must not take down a client that is still open on an older one", () => {
  test("host with two tabs: closing the second tab leaves the host connected, in control, and receiving HEALTH on the first", () => {
    const room = new Room("DUP1", fakeServer(), () => {}, library);
    const tab1 = fakeWs();
    const tab2 = fakeWs();
    room.join(tab1.ws, join(room, "host-dup-0001", "host"));
    room.join(tab2.ws, join(room, "host-dup-0001", "host"));
    expect(room.sockets.get("host-dup-0001")).toBe(tab2.ws);

    room.disconnect(tab2.ws); // the newer tab is closed
    expect(room.room.clients["host-dup-0001"]!.connected).toBe(true);
    expect(room.sockets.get("host-dup-0001")).toBe(tab1.ws);
    expect((room as unknown as { disconnectTimers: Map<string, unknown> }).disconnectTimers.size).toBe(0); // no 2-minute death sentence armed

    room.handle(tab1.ws, { type: "SET_TRACK", trackId: "t" });
    expect(room.room.track?.id).toBe("t");
    (room as unknown as { publishHealth(): void }).publishHealth();
    expect(tab1.sent.some((m) => m.type === "HEALTH")).toBe(true);

    room.disconnect(tab1.ws); // now the client is really gone
    expect(room.room.clients["host-dup-0001"]!.connected).toBe(false);
    expect(room.sockets.has("host-dup-0001")).toBe(false);
    room.destroy();
  });

  test("three sockets closing in every order: connected exactly while at least one is open", () => {
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      const room = new Room("DUP2", fakeServer(), () => {}, library);
      const socks = [fakeWs(), fakeWs(), fakeWs()];
      for (const s of socks) room.join(s.ws, join(room, "play-dup-0001", "player"));
      order.forEach((i, n) => {
        room.disconnect(socks[i]!.ws);
        const stillOpen = n < 2;
        expect(room.room.clients["play-dup-0001"]!.connected).toBe(stillOpen);
        if (stillOpen) {
          // the registered socket is always one that is still open
          const open = order.slice(n + 1).map((j) => socks[j]!.ws);
          expect(open).toContain(room.sockets.get("play-dup-0001")!);
        }
      });
      expect((room as unknown as { standby: Map<string, unknown> }).standby.size).toBe(0);
      room.destroy();
    }
  });

  test("KICK closes every socket of the client, and a kicked socket's late close cannot disconnect a re-joined client", () => {
    const room = new Room("DUP3", fakeServer(), () => {}, library);
    const host = fakeWs();
    room.join(host.ws, join(room, "host-dup-0003", "host"));
    const a = fakeWs();
    const b = fakeWs();
    room.join(a.ws, join(room, "play-dup-0003", "player"));
    room.join(b.ws, join(room, "play-dup-0003", "player"));

    room.handle(host.ws, { type: "KICK", clientId: "play-dup-0003" });
    expect(a.isClosed()).toBe(true);
    expect(b.isClosed()).toBe(true);
    expect(room.room.clients["play-dup-0003"]).toBeUndefined();

    const again = fakeWs();
    room.join(again.ws, join(room, "play-dup-0003", "player"));
    room.disconnect(a.ws);
    room.disconnect(b.ws);
    expect(room.room.clients["play-dup-0003"]!.connected).toBe(true);
    expect(room.sockets.get("play-dup-0003")).toBe(again.ws);
    // a kicked socket has no identity left: it cannot speak for the re-joined client
    room.handle(a.ws, { type: "NUDGE", clientId: "play-dup-0003", nudgeMs: 77 });
    expect(room.room.clients["play-dup-0003"]!.nudgeMs).toBe(0);
    room.destroy();
  });
});
