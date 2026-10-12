import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { DISCONNECT_RETENTION_MS, PROTOCOL_VERSION, ROOM_IDLE_TTL_MS, type ServerMessage } from "@hive/protocol";
import { MAX_ROOMS, ROOM_UNCLAIMED_TTL_MS, RoomManager, type Conn } from "../rooms";
import { RateLimiter } from "../rate-limit";

/**
 * Audit SG-06: `POST /rooms` is unauthenticated and every call leaked a room forever. The idle
 * timer was only ever armed when a room's last client record expired, so a room nobody joined had
 * no timer at all: 20 000 calls → 20 000 live rooms (40 000 intervals, ~80 MB heap) that nothing
 * would ever collect, and nothing stopped the next 20 000.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const joinMsg = (clientId: string, roomCode: string, kind: "host" | "player", hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });
function newManager() {
  const m = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: "lifecycle-test-secret-0123456789abcdef" });
  m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
  return m;
}
const code = (r: ReturnType<RoomManager["createRoom"]>) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("SG-06: rooms cannot accumulate", () => {
  test("a room nobody ever joins is collected after ROOM_UNCLAIMED_TTL_MS", () => {
    const m = newManager();
    for (let i = 0; i < 500; i++) code(m.createRoom());
    expect(m.roomCount).toBe(500);
    jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS - 1000);
    expect(m.roomCount).toBe(500);
    jest.advanceTimersByTime(2000);
    expect(m.roomCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0); // and every interval/timeout went with them
  });

  test("a joined room is NOT collected by the unclaimed timer; it lives until it has been empty for ROOM_IDLE_TTL_MS", () => {
    const m = newManager();
    const r = code(m.createRoom());
    const host = fakeWs();
    m.handleMessage(host.ws, joinMsg("host-life-0001", r.code, "host", r.hostKey));
    jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS * 3);
    expect(m.get(r.code)).toBeDefined();

    m.handleClose(host.ws);
    jest.advanceTimersByTime(DISCONNECT_RETENTION_MS + 1000); // record retained, then dropped → idle clock starts
    expect(m.get(r.code)).toBeDefined();
    jest.advanceTimersByTime(ROOM_IDLE_TTL_MS - 5000);
    expect(m.get(r.code)).toBeDefined();
    jest.advanceTimersByTime(10_000);
    expect(m.get(r.code)).toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a host slower than the unclaimed TTL still gets its room: the signed key re-creates it on JOIN", () => {
    const m = newManager();
    const r = code(m.createRoom());
    jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS + 1000);
    expect(m.get(r.code)).toBeUndefined();
    const host = fakeWs();
    m.handleMessage(host.ws, joinMsg("host-life-0002", r.code, "host", r.hostKey));
    expect(host.sent.find((x) => x.type === "WELCOME")).toMatchObject({ isHost: true });
    expect(m.get(r.code)!.hostKey).toBe(r.hostKey);
    m.get(r.code)!.destroy();
  });

  test(`at most MAX_ROOMS (${MAX_ROOMS}) rooms exist; past that POST /rooms answers 503 server_full and a restore is refused too`, () => {
    const m = newManager();
    const first = code(m.createRoom());
    jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS + 1000); // `first` is gone but its key is still good
    for (let i = 0; i < MAX_ROOMS; i++) code(m.createRoom());
    expect(m.roomCount).toBe(MAX_ROOMS);

    expect(m.createRoom()).toEqual({ error: "server_full", status: 503 });
    expect(m.createRoom(first.code, first.hostKey)).toEqual({ error: "server_full", status: 503 });
    const host = fakeWs();
    m.handleMessage(host.ws, joinMsg("host-life-0003", first.code, "host", first.hostKey));
    expect(host.sent[0]).toMatchObject({ type: "ERROR", code: "NO_ROOM" });
    expect(m.roomCount).toBe(MAX_ROOMS);

    jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS + 1000); // the flood expires on its own
    expect(m.roomCount).toBe(0);
    expect(code(m.createRoom(first.code, first.hostKey)).restored).toBe(true);
    m.get(first.code)!.destroy();
  });
});

describe("RateLimiter", () => {
  test("allows `limit` per window per key, then refuses until the window ends; keys are independent", () => {
    const rl = new RateLimiter(3, 60_000);
    expect([1, 2, 3, 4, 5].map(() => rl.allow("a", 1000))).toEqual([true, true, true, false, false]);
    expect(rl.allow("b", 1000)).toBe(true);
    expect(rl.allow("a", 60_999)).toBe(false);
    expect(rl.allow("a", 61_000)).toBe(true);
  });

  test("its table cannot grow without bound", () => {
    const rl = new RateLimiter(3, 60_000);
    for (let i = 0; i < 50_000; i++) rl.allow(`ip-${i}`, i);
    expect((rl as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(10_000);
  });
});
