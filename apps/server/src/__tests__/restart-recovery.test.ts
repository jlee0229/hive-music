import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@hive/protocol";
import { JOIN_PARK_MS, MAX_PARKED_JOINS, RESTART_GRACE_MS, RoomManager, type Conn } from "../rooms";

/**
 * Audit SG-15. After a deploy every phone reconnects in the same second. A guest whose JOIN reached
 * the new process before the host's got NO_ROOM — and the client never asks again (the socket stays
 * open, un-joined; the player page shows "Hive not found"). Measured with the real sync-client
 * transport: 2 of 3 guests stranded in one run, 0 of 3 in the next — a coin flip per phone, per
 * deploy. For RESTART_GRACE_MS after boot, a JOIN for a missing room is now held for up to
 * JOIN_PARK_MS and admitted the moment the host's signed key re-creates the room.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const SECRET = "restart-recovery-secret-0123456789abcdef";
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const joinMsg = (clientId: string, roomCode: string, kind: "host" | "player" | "viewer", hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });
function newManager() {
  const m = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: SECRET });
  m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
  return m;
}
const types = (s: { sent: ServerMessage[] }) => s.sent.filter((m) => m.type !== "ROOM_STATE").map((m) => (m.type === "ERROR" ? `ERROR ${m.code}` : m.type));
/** A room that existed in "the process before the restart". */
function previousLife() {
  const before = newManager();
  const room = before.createRoom();
  if ("error" in room) throw new Error(room.error);
  before.get(room.code)!.destroy();
  return room;
}

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("SG-15: guests survive a restart whichever order the reconnects arrive in", () => {
  test("guests whose JOINs beat the host's are held, then admitted when the host's key re-creates the room", () => {
    const room = previousLife();
    const m = newManager(); // the restarted process
    const guests = [fakeWs(), fakeWs(), fakeWs()];
    guests.forEach((g, i) => m.handleMessage(g.ws, joinMsg(`guest-rr-00${i}`, room.code, i === 2 ? "viewer" : "player")));
    expect(guests.map(types)).toEqual([[], [], []]); // no NO_ROOM
    expect(m.get(room.code)).toBeUndefined(); // …and no room conjured by guests
    expect(m.parkedCount).toBe(3);

    jest.advanceTimersByTime(4000); // the host's backoff
    const host = fakeWs();
    m.handleMessage(host.ws, joinMsg("host-rr-0001", room.code, "host", room.hostKey));

    const live = m.get(room.code)!;
    expect(types(host)).toEqual(["WELCOME"]);
    expect(guests.map(types)).toEqual([["WELCOME"], ["WELCOME"], ["WELCOME"]]);
    expect(live.room.hostClientIds).toEqual(["host-rr-0001"]);
    expect(Object.values(live.room.clients).map((c) => `${c.id}:${c.kind}:${c.joinIndex}`)).toEqual(["host-rr-0001:host:0", "guest-rr-000:player:1", "guest-rr-001:player:2", "guest-rr-002:viewer:3"]);
    expect(m.parkedCount).toBe(0);
    // a held guest is an ordinary client afterwards
    m.handleMessage(guests[0]!.ws, JSON.stringify({ type: "NUDGE", clientId: "guest-rr-000", nudgeMs: 7 }));
    expect(live.room.clients["guest-rr-000"]!.nudgeMs).toBe(7);
    live.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a host that reloads the page instead (POST /rooms {code, hostKey}) admits the waiting guests too", () => {
    const room = previousLife();
    const m = newManager();
    const guest = fakeWs();
    m.handleMessage(guest.ws, joinMsg("guest-rr-0010", room.code, "player"));
    expect(m.createRoom(room.code, room.hostKey)).toMatchObject({ restored: true });
    expect(types(guest)).toEqual(["WELCOME"]);
    m.get(room.code)!.destroy();
  });

  test("nobody with the key shows up: the held JOIN gets the usual NO_ROOM after JOIN_PARK_MS, and may try again", () => {
    const room = previousLife();
    const m = newManager();
    const guest = fakeWs();
    m.handleMessage(guest.ws, joinMsg("guest-rr-0020", room.code, "player"));
    m.handleMessage(guest.ws, joinMsg("guest-rr-0020", room.code, "player")); // an impatient second JOIN while held
    expect(types(guest)).toEqual(["ERROR ALREADY_JOINED"]);
    jest.advanceTimersByTime(JOIN_PARK_MS - 100);
    expect(types(guest)).toEqual(["ERROR ALREADY_JOINED"]);
    jest.advanceTimersByTime(200);
    expect(types(guest)).toEqual(["ERROR ALREADY_JOINED", "ERROR NO_ROOM"]);
    expect(m.parkedCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);

    m.handleMessage(guest.ws, joinMsg("guest-rr-0020", room.code, "player")); // held again, not refused as "already joined"
    expect(m.parkedCount).toBe(1);
    m.handleClose(guest.ws);
  });

  test("a held socket that closes leaves nothing behind", () => {
    const room = previousLife();
    const m = newManager();
    const socks = Array.from({ length: 20 }, () => fakeWs());
    socks.forEach((s, i) => m.handleMessage(s.ws, joinMsg(`guest-rr-1${String(i).padStart(3, "0")}`, room.code, "player")));
    expect(m.parkedCount).toBe(20);
    socks.forEach((s) => m.handleClose(s.ws));
    expect(m.parkedCount).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    // the host arriving later re-creates an empty room: nobody is admitted from a closed socket
    const host = fakeWs();
    m.handleMessage(host.ws, joinMsg("host-rr-0002", room.code, "host", room.hostKey));
    expect(Object.keys(m.get(room.code)!.room.clients)).toEqual(["host-rr-0002"]);
    m.get(room.code)!.destroy();
  });

  test("holding is only for the minutes after boot, only for real codes, and bounded", () => {
    const room = previousLife();
    const m = newManager();

    const notACode = fakeWs();
    m.handleMessage(notACode.ws, joinMsg("guest-rr-2000", "AB1D", "player")); // "1" is not in the alphabet
    expect(types(notACode)).toEqual(["ERROR NO_ROOM"]);

    const many = Array.from({ length: MAX_PARKED_JOINS + 5 }, () => fakeWs());
    many.forEach((s, i) => {
      (s.ws.data as Conn).ip = `10.0.${i >> 8}.${i & 255}`; // distinct callers, so the per-caller miss budget is not what stops them
      m.handleMessage(s.ws, joinMsg(`guest-rr-3${String(i).padStart(4, "0")}`, room.code, "player"));
    });
    expect(m.parkedCount).toBe(MAX_PARKED_JOINS);
    expect(many.slice(MAX_PARKED_JOINS).map(types)).toEqual(Array(5).fill(["ERROR NO_ROOM"]));
    many.forEach((s) => m.handleClose(s.ws));

    jest.advanceTimersByTime(RESTART_GRACE_MS + 1000); // long after boot: a missing room is just missing
    const late = fakeWs();
    (late.ws.data as Conn).ip = "10.9.9.9";
    m.handleMessage(late.ws, joinMsg("guest-rr-4000", room.code, "player"));
    expect(types(late)).toEqual(["ERROR NO_ROOM"]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
