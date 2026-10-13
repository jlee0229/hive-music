// Scale characterisation of ROOM_STATE (audit scale-net). No server, no sockets: the rooms are built by
// apps/server/scripts/room-state-size.ts with the real planner, so these are the bytes on the wire.
//
// The property worth pinning is the first one: the server plans centrally and stamps each record
// with its finished assignment, so a per-recipient snapshot — a player receives the room-level state
// plus its own record, and only hosts/viewers receive the roster — is a pure server-side change:
// the message still validates against today's RoomStateSchema and the engine computes nothing from
// anyone else's record.
//
// (This used to assert something stronger: that plan() of a client alone equals its assignment in
// the full room. The planner now reads the roster on purpose — a lone phone plays every stem,
// STROBE deals groups over the phones present, auto-placed phones share one layout — so that claim
// is false by design. What per-recipient delivery needs is weaker and is what is tested here: the
// assignment travels in the record, and a client never has to re-plan.)
import { describe, expect, test } from "bun:test";
import { MODES, RoomStateSchema, parseServerMessage, withAssignments, type RoomState } from "@hive/protocol";
import { buildRoom } from "../../scripts/room-state-size";
import { Room, type Conn } from "../rooms";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** What one player would be sent: every room-level field, a roster of exactly one. */
function playerView(room: RoomState, id: string): RoomState {
  return {
    ...room,
    calibration: { ...room.calibration, order: [], results: {} },
    clients: { [id]: room.clients[id]! },
  };
}

describe("ROOM_STATE at scale", () => {
  test("every speaker's finished assignment travels in its own record, in every mode", () => {
    for (const mode of MODES) {
      for (const stems of [1, 4]) {
        for (const seed of [1, 2, 3]) {
          const room = withAssignments(buildRoom(40, mode, stems, seed));
          for (const c of Object.values(room.clients)) {
            const view = playerView(room, c.id);
            const parsed = parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room: view }));
            expect(parsed?.type).toBe("ROOM_STATE");
            if (parsed?.type !== "ROOM_STATE") continue;
            // The one-record view carries exactly what the full roster says about this client:
            // nothing the engine consumes has to be recomputed from anyone else's record.
            expect(parsed.room.clients[c.id]!.assignment).toEqual(room.clients[c.id]!.assignment);
            if (c.plays) expect(parsed.room.clients[c.id]!.assignment).not.toBeNull();
          }
        }
      }
    }
  });

  test("a per-recipient snapshot is a valid ROOM_STATE today and does not grow with the room", () => {
    const sizes: number[] = [];
    for (const n of [30, 100, 300]) {
      const room = buildRoom(n, "STROBE", 1);
      const me = Object.values(room.clients).find((c) => c.kind === "player")!;
      const view = playerView(room, me.id);
      expect(RoomStateSchema.safeParse(view).success).toBe(true);
      const parsed = parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room: view }));
      expect(parsed?.type).toBe("ROOM_STATE");
      // Everything the engine and the player page read: room-level state and room.clients[self].
      if (parsed?.type === "ROOM_STATE") expect(parsed.room.clients[me.id]!.assignment).toEqual(room.clients[me.id]!.assignment);
      sizes.push(bytes({ type: "ROOM_STATE", room: view }));
    }
    expect(Math.max(...sizes)).toBeLessThan(2000);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
  });

  test("today's snapshot costs more than 600 bytes per client, so egress per broadcast is quadratic", () => {
    const at = (n: number) => bytes({ type: "ROOM_STATE", room: buildRoom(n, "STROBE", 1) });
    const s100 = at(100);
    const s200 = at(200);
    expect(s100 / 100).toBeGreaterThan(600);
    // Linear message x linear audience: doubling the room quadruples what one broadcast writes.
    expect((200 * s200) / (100 * s100)).toBeGreaterThan(3.9);
  });
});

// ---- the real thing: what Room actually sends each recipient (SCALE-NET-02, implemented in rooms.ts) --------
type WS = Bun.ServerWebSocket<Conn>;

/** A real Room holding `state`, with one capturing socket registered per client record. */
function roomWith(state: RoomState) {
  const room = new Room(state.code, { publish: () => {} } as unknown as Bun.Server<Conn>, () => {}, () => []);
  room.room = withAssignments(state);
  const inbox = new Map<string, string[]>();
  for (const id of Object.keys(state.clients)) {
    const got: string[] = [];
    inbox.set(id, got);
    room.sockets.set(id, { data: { clientId: id, roomCode: state.code }, send: (raw: string) => void got.push(raw), subscribe: () => {}, close: () => {} } as unknown as WS);
  }
  const sendState = (refreshOlderThanMs?: number) => (room as unknown as { sendState(ms?: number): boolean }).sendState(refreshOlderThanMs);
  return { room, inbox, sendState };
}
const lastRoom = (raws: string[]) => {
  const msg = parseServerMessage(raws.at(-1)!);
  if (msg?.type !== "ROOM_STATE") throw new Error("not a ROOM_STATE");
  return msg.room;
};

describe("ROOM_STATE per recipient (the server's own fan-out)", () => {
  // The server's budget (scripts/load-test.ts: "largest message <= 64 KB") was a test.failing on the
  // whole-roster snapshot: ~87 KB at 100 calibrated phones, crossed near 74. What a PHONE is sent now
  // does not grow with the room at all.
  test("a phone's ROOM_STATE in a 100- and a 250-phone room fits the 64 KB budget many times over", () => {
    for (const n of [100, 250]) {
      const { room, inbox, sendState } = roomWith(buildRoom(n, "STROBE", 1));
      sendState();
      const players = Object.values(room.room.clients).filter((c) => c.kind === "player");
      const sizes = players.map((c) => Buffer.byteLength(inbox.get(c.id)!.at(-1)!));
      expect(Math.max(...sizes)).toBeLessThanOrEqual(2048);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
      for (const c of players.slice(0, 20)) {
        const raw = JSON.parse(inbox.get(c.id)!.at(-1)!) as { room: unknown };
        expect(RoomStateSchema.safeParse(raw.room).success).toBe(true); // the strict schema, unchanged
        const view = lastRoom(inbox.get(c.id)!);
        expect(Object.keys(view.clients)).toEqual([c.id]);
        expect(view.clients[c.id]).toEqual(room.room.clients[c.id]!);
        expect(view.hostClientIds).toEqual([]);
        // everything room-level the engine and the player page read is there, untouched
        expect({ track: view.track, transport: view.transport, mode: view.mode, scenePlan: view.scenePlan, code: view.code }).toEqual({
          track: room.room.track,
          transport: room.room.transport,
          mode: room.room.mode,
          scenePlan: room.room.scenePlan,
          code: room.room.code,
        });
        // and nothing in the message names another client
        const others = Object.keys(room.room.clients).filter((id) => id !== c.id);
        const text = inbox.get(c.id)!.at(-1)!;
        expect(others.some((id) => text.includes(id))).toBe(false);
      }
      room.destroy();
    }
  });

  test("hosts and viewers still get the whole roster", () => {
    const state = buildRoom(100, "ORCHESTRA", 4);
    const viewerId = Object.keys(state.clients)[5]!;
    state.clients[viewerId] = { ...state.clients[viewerId]!, kind: "viewer", plays: false };
    const { room, inbox, sendState } = roomWith(state);
    sendState();
    for (const id of [room.room.hostClientIds[0]!, viewerId]) {
      const view = lastRoom(inbox.get(id)!);
      expect(Object.keys(view.clients).length).toBe(100);
      expect(view.hostClientIds).toEqual(room.room.hostClientIds);
      expect(view.calibration).toEqual(room.room.calibration);
      expect(JSON.parse(inbox.get(id)!.at(-1)!).room).toEqual(JSON.parse(JSON.stringify(room.room)));
    }
    room.destroy();
  });

  test("a recipient is only sent a ROOM_STATE that tells it something new", () => {
    const { room, inbox, sendState } = roomWith(buildRoom(60, "UNISON", 1));
    const hostId = room.room.hostClientIds[0]!;
    const players = Object.values(room.room.clients).filter((c) => c.kind === "player").map((c) => c.id);
    sendState();
    const counts = () => new Map([...inbox].map(([id, raws]) => [id, raws.length]));
    const before = counts();
    sendState(); // nothing changed at all: nobody is sent anything
    expect(counts()).toEqual(before);

    // the host drags ONE phone's dot (UNISON: positions change no one's sound)
    const dragged = players[7]!;
    room.room.clients[dragged]!.position = { x: 0.123, y: 0.456 };
    sendState();
    const after = counts();
    const grew = [...after].filter(([id, n]) => n > before.get(id)!).map(([id]) => id).sort();
    expect(grew).toEqual([hostId, dragged].sort()); // 2 messages instead of 60

    // a room-level change reaches everyone
    room.room.transport = { state: "paused", trackTimeAtPause: 12.5 };
    sendState();
    expect([...counts()].every(([id, n]) => n === after.get(id)! + 1)).toBe(true);

    // the heartbeat repeats an unchanged state, but only to recipients whose copy is old enough
    const settled = counts();
    sendState(60_000);
    expect(counts()).toEqual(settled);
    sendState(0);
    expect([...counts()].every(([id, n]) => n === settled.get(id)! + 1)).toBe(true);
    room.destroy();
  });

  test("during a tuning moment a phone sees how many clicks there are and which is its own — not whose the others are", () => {
    const state = buildRoom(30, "UNISON", 1);
    const ids = Object.keys(state.clients);
    const order = ids.slice(1);
    state.calibration = { state: "running", referenceClientId: ids[0]!, startServerTime: 1760180100000, order, results: {} };
    const { room, inbox, sendState } = roomWith(state);
    sendState();
    const me = order[11]!;
    const view = lastRoom(inbox.get(me)!);
    expect(view.calibration.state).toBe("running");
    expect(view.calibration.startServerTime).toBe(1760180100000);
    expect(view.calibration.order.length).toBe(order.length); // "N clicks"
    expect(view.calibration.order.indexOf(me)).toBe(11); // "yours is the 12th"
    expect(view.calibration.order.filter((id) => id !== "")).toEqual([me]);
    expect(view.calibration.referenceClientId).toBeNull();

    // done: results for everyone exist, a phone is sent only its own
    room.room.calibration = { ...room.room.calibration, state: "done", results: Object.fromEntries(order.map((id) => [id, { residualMs: 4, confidence: 0.9 }])) };
    sendState();
    const done = lastRoom(inbox.get(me)!);
    expect(done.calibration).toEqual({ state: "done", referenceClientId: null, startServerTime: 1760180100000, order: [], results: { [me]: { residualMs: 4, confidence: 0.9 } } });
    expect(lastRoom(inbox.get(ids[0]!)!).calibration).toEqual(room.room.calibration); // the host: all of it
    room.destroy();
  });

  // Hosts and viewers need the roster, so THEIR message still grows with the room (~87 KB at 100
  // calibrated phones). That is a handful of sockets instead of every phone; slimming the record is
  // the next step if it ever matters.
  test.failing("the HOST's roster for a 100-phone room fits the 64 KB message budget", () => {
    expect(bytes({ type: "ROOM_STATE", room: buildRoom(100, "STROBE", 1) })).toBeLessThanOrEqual(65536);
  });
});
