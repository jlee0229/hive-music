// Scale characterisation of ROOM_STATE (audit scale-net). No server, no sockets: the rooms are built by
// apps/server/scripts/room-state-size.ts with the real planner, so these are the bytes on the wire.
//
// The property worth pinning is the first one: an assignment depends only on (mode, track, that
// client's own record). That is what makes a per-recipient snapshot — a player receives the room-level
// state plus its own record, and only hosts/viewers receive the roster — a pure server-side change:
// the message still validates against today's RoomStateSchema and the engine computes nothing from
// anyone else's record. If a future mode ever reads a neighbour (say, "the phone to my left"), this
// test is where that shows up.
import { describe, expect, test } from "bun:test";
import { MODES, RoomStateSchema, parseServerMessage, plan, type RoomState } from "@hive/protocol";
import { buildRoom } from "../../scripts/room-state-size";

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
  test("an assignment depends only on the mode, the track and the client's own record", () => {
    for (const mode of MODES) {
      for (const stems of [1, 4]) {
        for (const seed of [1, 2, 3]) {
          const room = buildRoom(40, mode, stems, seed);
          const full = plan(room);
          for (const id of Object.keys(room.clients)) {
            const alone = plan({ ...room, clients: { [id]: room.clients[id]! } });
            expect(alone[id]).toEqual(full[id]!);
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

  // The server's own budget (apps/server/scripts/load-test.ts: "largest message <= 64 KB"). A realistic
  // calibrated 100-phone room is ~87 KB today; the budget is crossed near 74 phones. Flip this to
  // `test` when per-recipient snapshots (or a slimmer record) land.
  test.failing("a 100-phone room's snapshot fits the 64 KB message budget", () => {
    expect(bytes({ type: "ROOM_STATE", room: buildRoom(100, "STROBE", 1) })).toBeLessThanOrEqual(65536);
  });
});
