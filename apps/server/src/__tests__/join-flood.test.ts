import { afterAll, describe, expect, jest, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@hive/protocol";
import { MAX_ROOM_CLIENTS, RoomManager, type Conn } from "../rooms";

/**
 * Audit SG-04: client records could be minted without bound by anyone holding a room code.
 * Before: 5000 JOINs on ONE socket → 5000 records and a 2.5 MB ROOM_STATE (sent to every phone at
 * up to 2 Hz); when that socket closed, 4999 of them stayed `connected: true` forever, so the room
 * also never idled out.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const joinMsg = (clientId: string, roomCode: string, kind: "host" | "player" = "player", hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });
const errors = (s: { sent: ServerMessage[] }) => s.sent.flatMap((m) => (m.type === "ERROR" ? [m.code] : []));

const manager = new RoomManager({ fixturesDir: "/nonexistent" });
manager.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
const made: string[] = [];
const newRoom = () => {
  const r = manager.createRoom();
  if ("error" in r) throw new Error(r.error);
  made.push(r.code);
  return r;
};
afterAll(() => made.forEach((c) => manager.get(c)?.destroy()));

describe("SG-04: a room's client records are bounded", () => {
  test("one socket gets one seat: a second JOIN on it is refused, in this room or any other", () => {
    const a = newRoom();
    const b = newRoom();
    const s = fakeWs();
    manager.handleMessage(s.ws, joinMsg("flood-000000", a.code));
    for (let i = 1; i < 50; i++) manager.handleMessage(s.ws, joinMsg(`flood-${String(i).padStart(6, "0")}`, i % 2 ? a.code : b.code));

    expect(Object.keys(manager.get(a.code)!.room.clients)).toEqual(["flood-000000"]);
    expect(Object.keys(manager.get(b.code)!.room.clients)).toEqual([]);
    expect(errors(s)).toEqual(Array(49).fill("ALREADY_JOINED"));

    // and its close cleans up the only record it ever had
    manager.handleClose(s.ws);
    expect(Object.values(manager.get(a.code)!.room.clients).filter((c) => c.connected)).toEqual([]);
  });

  test("a JOIN that failed (NO_ROOM) does not burn the socket's one seat", () => {
    const a = newRoom();
    const s = fakeWs();
    manager.handleMessage(s.ws, joinMsg("retry-000001", "ZZZZ"));
    expect(errors(s)).toEqual(["NO_ROOM"]);
    manager.handleMessage(s.ws, joinMsg("retry-000001", a.code));
    expect(s.sent.some((m) => m.type === "WELCOME")).toBe(true);
  });

  test(`the ${MAX_ROOM_CLIENTS + 1}th distinct device gets ROOM_FULL; known devices can still reconnect; the host is never locked out of its own seat`, () => {
    const r = newRoom();
    const room = manager.get(r.code)!;
    const host = fakeWs();
    manager.handleMessage(host.ws, joinMsg("host-full-0001", r.code, "host", r.hostKey));
    const socks = [];
    for (let i = 0; i < MAX_ROOM_CLIENTS + 40; i++) {
      const s = fakeWs();
      manager.handleMessage(s.ws, joinMsg(`full-${String(i).padStart(6, "0")}`, r.code));
      socks.push(s);
    }
    expect(Object.keys(room.room.clients).length).toBe(MAX_ROOM_CLIENTS);
    const rejected = socks.filter((s) => errors(s).includes("ROOM_FULL"));
    expect(rejected.length).toBe(41); // 255 guests fit beside the host; 40 + 1 do not
    expect(rejected.every((s) => s.ws.data.roomCode === null && !s.sent.some((m) => m.type === "WELCOME"))).toBe(true);
    expect(JSON.stringify({ type: "ROOM_STATE", room: room.room }).length).toBeLessThan(200_000);

    // an existing record reconnects fine at the cap
    manager.handleClose(socks[0]!.ws);
    const back = fakeWs();
    manager.handleMessage(back.ws, joinMsg("full-000000", r.code));
    expect(back.sent.some((m) => m.type === "WELCOME")).toBe(true);

    // the host reconnects fine at the cap
    manager.handleClose(host.ws);
    const host2 = fakeWs();
    manager.handleMessage(host2.ws, joinMsg("host-full-0001", r.code, "host", r.hostKey));
    expect(host2.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: true });

    // even a key holder with NO record yet (its old one expired while the room was being stuffed) gets in — and can KICK
    const host3 = fakeWs();
    manager.handleMessage(host3.ws, joinMsg("host-full-0002", r.code, "host", r.hostKey));
    expect(host3.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: true });
    manager.handleMessage(host3.ws, JSON.stringify({ type: "KICK", clientId: "full-000001" }));
    expect(room.room.clients["full-000001"]).toBeUndefined();
  });
});

describe("SG-14: probing for room codes over the socket is budgeted per caller", () => {
  test("after 61 JOINs to codes that do not exist, that address is refused without a lookup for the rest of the minute; other addresses are not", () => {
    jest.useFakeTimers();
    try {
      const m = new RoomManager({ fixturesDir: "/nonexistent" });
      m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
      const real = m.createRoom();
      if ("error" in real) throw new Error(real.error);
      const from = (ip: string) => {
        const s = fakeWs();
        (s.ws.data as Conn).ip = ip;
        return s;
      };

      const scanner = from("203.0.113.9");
      for (let i = 0; i < 61; i++) m.handleMessage(scanner.ws, joinMsg("scan-000001", `Q${String(i).padStart(3, "0")}`));
      expect(errors(scanner)).toEqual(Array(61).fill("NO_ROOM"));

      // the 62nd probe — this time of a code that DOES exist — learns nothing and is hung up on
      let closed = false;
      const next = from("203.0.113.9");
      next.ws.close = () => void (closed = true);
      m.handleMessage(next.ws, joinMsg("scan-000002", real.code));
      expect(errors(next)).toEqual(["RATE_LIMITED"]);
      expect(next.sent.some((x) => x.type === "WELCOME")).toBe(false);
      expect(closed).toBe(true);
      expect(Object.keys(m.get(real.code)!.room.clients)).toEqual([]);

      // a guest at another address is unaffected
      const guest = from("198.51.100.20");
      m.handleMessage(guest.ws, joinMsg("guest-000001", real.code));
      expect(guest.sent.some((x) => x.type === "WELCOME")).toBe(true);

      // and the budget refills
      jest.advanceTimersByTime(61_000);
      const later = from("203.0.113.9");
      m.handleMessage(later.ws, joinMsg("scan-000003", real.code));
      expect(later.sent.some((x) => x.type === "WELCOME")).toBe(true);
      m.get(real.code)!.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
