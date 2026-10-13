import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { DISCONNECT_RETENTION_MS, PROTOCOL_VERSION, STEMS, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * PROTO-05: `connected` is a planner input now — an offline phone's stem is folded onto the phones
 * that are still here, STROBE groups are dealt over the phones present. The server marked a
 * disconnect "dirty" but did not re-plan, so the room kept broadcasting the old assignments: the
 * part of the song that phone was carrying went silent until something else caused a re-plan.
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
const SILENT_DB = -60;

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("PROTO-05: a phone that drops does not take its part of the song with it", () => {
  function orchestra() {
    const room = new Room("ORCH", fakeServer(), () => {}, () => [{ id: "t", title: "t", durationSec: 120, stems: [...STEMS] }]);
    const host = fakeWs();
    room.join(host.ws, join(room, "host-orch-0001", "host"));
    const phones = STEMS.map((_, i) => {
      const p = fakeWs();
      room.join(p.ws, join(room, `play-orch-000${i}`, "player"));
      return p;
    });
    room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
    room.handle(host.ws, { type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
    jest.advanceTimersByTime(1100);
    /** Stems that at least one CONNECTED speaker is playing, per the latest state the host was sent. */
    const audible = () => {
      const out = new Set<string>();
      for (const c of Object.values(host.lastRoom().clients)) {
        if (!c.connected || !c.assignment) continue;
        for (const [stem, db] of Object.entries(c.assignment.gainsDb)) if (db > SILENT_DB) out.add(stem);
      }
      return [...out].sort();
    };
    return { room, host, phones, audible };
  }

  test("ORCHESTRA: within one broadcast of a disconnect, the dropped phone's stem is audible on someone else", () => {
    const { room, host, phones, audible } = orchestra();
    expect(audible()).toEqual([...STEMS].sort()); // four phones, four stems
    // which stem is phone 2 carrying alone?
    const carried = Object.entries(host.lastRoom().clients["play-orch-0002"]!.assignment!.gainsDb).filter(([, db]) => db > SILENT_DB).map(([s]) => s);
    expect(carried.length).toBe(1);

    room.disconnect(phones[2]!.ws);
    jest.advanceTimersByTime(600); // one coalescing window
    expect(host.lastRoom().clients["play-orch-0002"]!.connected).toBe(false);
    expect(audible()).toEqual([...STEMS].sort()); // still the whole song
    // and the phone that took it over was TOLD so (its own per-recipient snapshot carries the new gains)
    const coveringNow = phones.filter((p, i) => i !== 2 && (p.lastRoom().clients[`play-orch-000${i}`]!.assignment!.gainsDb[carried[0]!] ?? SILENT_DB) > SILENT_DB);
    expect(coveringNow.length).toBeGreaterThanOrEqual(1);

    // it comes back: one stem each again
    const back = fakeWs();
    room.join(back.ws, join(room, "play-orch-0002", "player"));
    jest.advanceTimersByTime(600);
    for (const c of Object.values(host.lastRoom().clients)) {
      if (c.kind !== "player") continue;
      expect(Object.values(c.assignment!.gainsDb).filter((db) => db > SILENT_DB).length).toBe(1);
    }
    room.destroy();
  });

  test("the plan is redone again when the retained record finally expires", () => {
    const { room, host, phones, audible } = orchestra();
    room.disconnect(phones[0]!.ws);
    jest.advanceTimersByTime(DISCONNECT_RETENTION_MS + 1000);
    expect(host.lastRoom().clients["play-orch-0000"]).toBeUndefined();
    expect(Object.values(room.room.clients).filter((c) => c.kind === "player").length).toBe(3);
    expect(audible()).toEqual([...STEMS].sort());
    // what the room holds is exactly what a fresh plan of it would be
    const { withAssignments } = require("@hive/protocol") as typeof import("@hive/protocol");
    expect(JSON.stringify(room.room.clients)).toBe(JSON.stringify(withAssignments(room.room).clients));
    room.destroy();
  });
});
