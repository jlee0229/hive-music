import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * SCALE-NET-03. A phone whose tab is frozen keeps its connection but stops draining it, and every
 * snapshot published after that used to be queued for it in the server's memory: 10 such sockets
 * in a 200-phone room added 142 MB in 69 s (scripts/slow-consumer.ts) — on a 256 MB machine that is
 * every party. A snapshot is superseded by the next one, so it is now never queued behind a backlog;
 * the socket gets the current state once it has drained. (With index.ts's backpressureLimit +
 * closeOnBackpressureLimit as the backstop, the same script now shows RSS flat: +10 MB.)
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  const state = { buffered: 0 };
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => void sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {}, getBufferedAmount: () => state.buffered } as unknown as WS;
  const count = (type: ServerMessage["type"]) => sent.filter((m) => m.type === type).length;
  return { ws, sent, state, count };
}
const join = (room: Room, clientId: string, kind: "host" | "player" | "viewer"): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: room.code,
  kind,
  plays: kind === "player",
  hostKey: kind === "host" ? room.hostKey : undefined,
  device,
  protocolVersion: PROTOCOL_VERSION,
});

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("SCALE-NET-03: snapshots are not queued for a socket that is not reading", () => {
  test("a stalled viewer is sent no ROOM_STATE or HEALTH while it has a backlog, and the current state as soon as it drains", () => {
    const room = new Room("SLOW", fakeServer(), () => {}, () => [{ id: "t", title: "t", durationSec: 60, stems: ["mix"], urls: {} }]);
    const host = fakeWs();
    const viewer = fakeWs();
    const phone = fakeWs();
    room.join(host.ws, join(room, "host-slow-0001", "host"));
    room.join(viewer.ws, join(room, "view-slow-0001", "viewer"));
    room.join(phone.ws, join(room, "play-slow-0001", "player"));
    jest.advanceTimersByTime(1100);
    const settled = { viewer: viewer.count("ROOM_STATE"), host: host.count("ROOM_STATE"), health: viewer.count("HEALTH") };
    expect(settled.viewer).toBeGreaterThan(0);
    expect(settled.health).toBeGreaterThan(0);

    viewer.state.buffered = 300_000; // the tab froze: nothing is being read any more
    for (let i = 0; i < 40; i++) {
      room.handle(host.ws, { type: "SET_POSITION", clientId: "play-slow-0001", x: i / 40, y: 0.5 }); // the host drags a dot for 20 s
      jest.advanceTimersByTime(500);
    }
    expect(host.count("ROOM_STATE")).toBeGreaterThan(settled.host + 30); // the room kept broadcasting…
    expect(viewer.count("ROOM_STATE")).toBe(settled.viewer); // …and none of it was queued for the stalled socket
    expect(viewer.count("HEALTH")).toBe(settled.health);

    viewer.state.buffered = 0; // it wakes up; nothing else changes in the room
    jest.advanceTimersByTime(1100);
    expect(viewer.count("ROOM_STATE")).toBe(settled.viewer + 1);
    const last = viewer.sent.filter((m) => m.type === "ROOM_STATE").at(-1)!;
    if (last.type === "ROOM_STATE") expect(last.room.clients["play-slow-0001"]!.position).toEqual({ x: 39 / 40, y: 0.5 });
    expect(viewer.count("HEALTH")).toBeGreaterThan(settled.health);

    // and once everyone is current, the retry stops: no timer keeps firing for a caught-up room
    const quiet = { host: host.count("ROOM_STATE"), viewer: viewer.count("ROOM_STATE"), phone: phone.count("ROOM_STATE") };
    jest.advanceTimersByTime(10_000);
    expect({ host: host.count("ROOM_STATE"), viewer: viewer.count("ROOM_STATE"), phone: phone.count("ROOM_STATE") }).toEqual(quiet);
    room.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
