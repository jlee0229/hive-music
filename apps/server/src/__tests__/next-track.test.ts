import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { PROTOCOL_VERSION, RoomStateSchema, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";
import type { LibraryEntry } from "../library";

/**
 * `RoomState.nextTrack` (protocol commit 51b44eb): the song the playlist will advance to, published
 * while the current one plays so phones can download it ahead — an 18 MB stem takes ~15 s on a
 * 10 Mbit/s link and the advance itself gives a 5 s lead. The server keeps it current when the host
 * picks a song, when the playlist advances, and when the library changes under a running room.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => void sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  const lastRoom = () => {
    const m = sent.filter((x) => x.type === "ROOM_STATE").at(-1);
    if (m?.type !== "ROOM_STATE") throw new Error("no ROOM_STATE yet");
    return m.room;
  };
  return { ws, sent, lastRoom };
}
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
const song = (id: string, durationSec: number, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({ id, title: id.toUpperCase(), durationSec, stems: ["mix"], ...extra });

function party(library: LibraryEntry[]) {
  const lib = { current: library };
  const room = new Room("NEXT", fakeServer(), () => {}, () => lib.current);
  const host = fakeWs();
  const phone = fakeWs();
  room.join(host.ws, join(room, "host-next-0001", "host"));
  room.join(phone.ws, join(room, "play-next-0001", "player"));
  return { room, host, phone, lib };
}

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("RoomState.nextTrack", () => {
  test("follows the rotation: the next real song, wrapping, never a generated one while real ones exist", () => {
    const { room, host, phone } = party([song("a", 100, { bpm: 120, beatOffsetSec: 0.25 }), song("b", 90, { bpm: 98.5 }), song("synth", 60, { generated: true })]);
    expect(room.room.nextTrack ?? null).toBeNull(); // no track yet: nothing to follow

    room.handle(host.ws, { type: "SET_TRACK", trackId: "a" });
    expect(room.room.nextTrack).toEqual({ id: "b", title: "B", durationSec: 90, stems: ["mix"], bpm: 98.5, beatOffsetSec: undefined });
    room.handle(host.ws, { type: "SET_TRACK", trackId: "b" });
    expect(room.room.nextTrack).toMatchObject({ id: "a", bpm: 120, beatOffsetSec: 0.25 }); // wraps past the synthetic track
    room.handle(host.ws, { type: "SET_TRACK", trackId: "synth" });
    expect(room.room.nextTrack).toMatchObject({ id: "a" }); // from a test track, the party goes to the real ones

    // every recipient is told, and it is a valid ROOM_STATE
    jest.advanceTimersByTime(1100);
    expect(phone.lastRoom().nextTrack).toMatchObject({ id: "a" });
    expect(host.lastRoom().nextTrack).toMatchObject({ id: "a" });
    expect(RoomStateSchema.safeParse(JSON.parse(JSON.stringify(room.room))).success).toBe(true);
    room.destroy();
  });

  test("a single-song loop has no next track", () => {
    const { room, host, phone } = party([song("only", 30), song("synth", 60, { generated: true })]);
    room.handle(host.ws, { type: "SET_TRACK", trackId: "only" });
    expect(room.room.nextTrack ?? null).toBeNull(); // absent and null mean the same
    jest.advanceTimersByTime(1100);
    expect(phone.lastRoom().nextTrack ?? null).toBeNull();
    room.destroy();
  });

  test("an upload during a song changes what comes next, and phones hear about it without waiting for anything else", () => {
    const { room, host, phone, lib } = party([song("only", 200)]);
    room.handle(host.ws, { type: "SET_TRACK", trackId: "only" });
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    jest.advanceTimersByTime(5000);
    expect(phone.lastRoom().nextTrack ?? null).toBeNull();
    const before = phone.sent.filter((m) => m.type === "ROOM_STATE").length;

    lib.current = [song("only", 200), song("uploaded", 180, { bpm: 128 })]; // what manager.reloadLibrary() does after POST /tracks
    room.onLibraryChanged();
    jest.advanceTimersByTime(600);
    expect(phone.sent.filter((m) => m.type === "ROOM_STATE").length).toBe(before + 1);
    expect(phone.lastRoom().nextTrack).toMatchObject({ id: "uploaded", bpm: 128 });

    room.onLibraryChanged(); // a reload that changes nothing for this room sends nothing
    jest.advanceTimersByTime(600);
    expect(phone.sent.filter((m) => m.type === "ROOM_STATE").length).toBe(before + 1);
    room.destroy();
  });

  test("the playlist advance lands on what nextTrack promised, and then points one further on", () => {
    const { room, host, phone } = party([song("a", 8), song("b", 20), song("c", 20)]);
    room.handle(host.ws, { type: "SET_TRACK", trackId: "a" });
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    jest.advanceTimersByTime(1000);
    expect(phone.lastRoom()).toMatchObject({ track: { id: "a" }, nextTrack: { id: "b" } });
    jest.advanceTimersByTime(8000); // the song ends
    expect(phone.lastRoom()).toMatchObject({ track: { id: "b" }, nextTrack: { id: "c" } });
    room.destroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
