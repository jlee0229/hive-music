/**
 * The mock sends ROOM_STATE per recipient, exactly as apps/server does (`sendState` in rooms.ts): a
 * player is told the room-level state and its own record; hosts, viewers and observers get the room.
 *
 * Why this is pinned: the whole browser suite runs against the mock. While the mock published the full
 * room to everyone, the guest page could decide "the host has gone" by looking the host up in the
 * roster — green in every test, and impossible in production, where a guest's roster is itself. The
 * cross-check against the real server is `scripts/parity-probe.ts` (the `playerView*` observations).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../constants";
import { playerRoomView, startMockServer } from "../mock-server";
import type { RoomState } from "../room";
import { Raw, device, sleep, testPort } from "./harness";

const PORT = testPort(4);
const HOST = "pv-host-aaaa0001";
const ANN = "pv-play-bbbb0002";
const BEN = "pv-play-cccc0003";
const SCREEN = "pv-view-dddd0004";
const SEEDED = "mock-01-zedzed9905";
// Names no track title or field name could contain by accident.
const nameOf: Record<string, string> = { [HOST]: "Hostess-9901", [ANN]: "Annika-9902", [BEN]: "Benoit-9903", [SCREEN]: "Wallscreen-9904", [SEEDED]: "Zedzed9905" };
/** Every id and name that is somebody else's, from a player's point of view. */
const others = (me: string) => [...Object.keys(nameOf), ...Object.values(nameOf)].filter((x) => x !== me && x !== nameOf[me]);

let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [{ name: nameOf[SEEDED]! }] } });
  await mock.ready;
});
afterAll(() => mock.stop());

/** A joined socket that also keeps the raw text of every frame: "is that id anywhere in it" is a question about bytes. */
async function joined(clientId: string, kind: "host" | "player" | "viewer", withKey = kind === "host") {
  const s = new Raw(PORT);
  const frames: string[] = [];
  s.ws.addEventListener("message", (ev) => frames.push(String(ev.data)));
  await s.open();
  s.send({ type: "JOIN", clientId, roomCode: "BZQ7", kind, plays: kind === "player", name: nameOf[clientId], hostKey: withKey ? mock.hostKey : undefined, device, protocolVersion: PROTOCOL_VERSION });
  await s.next("WELCOME");
  const states = () => frames.filter((f) => f.startsWith('{"type":"ROOM_STATE"'));
  const last = () => (JSON.parse(states().at(-1)!) as { room: RoomState }).room;
  return Object.assign(s, { frames, states, last });
}
type Joined = Awaited<ReturnType<typeof joined>>;

/** Round-trip through JSON, as the wire does (drops `undefined`, which a deep-equal would otherwise see). */
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const roomLevel = ({ clients: _c, calibration: _cal, hostClientIds: _h, ...level }: RoomState) => level;

describe("mock ↔ server parity: ROOM_STATE is sent per recipient", () => {
  let host: Joined, ann: Joined, ben: Joined, screen: Joined;
  beforeAll(async () => {
    host = await joined(HOST, "host");
    ann = await joined(ANN, "player");
    ben = await joined(BEN, "player");
    screen = await joined(SCREEN, "viewer");
    for (const p of [ann, ben]) p.send({ type: "AUDIO_READY", trackId: mock.room.track!.id });
    // one change everyone is told about, so every socket holds a snapshot of the same room
    host.send({ type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    await Promise.all([host, ann, ben, screen].map((s) => s.next("ROOM_STATE", (m) => m.room.mode.kind === "ORCHESTRA")));
    await host.next("ROOM_STATE", (m) => m.room.clients[BEN]?.audioReadyTrackId === mock.room.track!.id);
    await sleep(600); // one publish tick: the AUDIO_READYs have reached everyone
  });
  afterAll(() => {
    for (const s of [host, ann, ben, screen]) s?.close();
  });

  test("a player's snapshot is the room-level state and its own record — nobody else's", () => {
    for (const [me, s] of [[ANN, ann], [BEN, ben]] as const) {
      const room = s.last();
      expect(Object.keys(room.clients)).toEqual([me]);
      expect(room.hostClientIds).toEqual([]);
      expect(room.hostConnected).toBe(true);
      expect(room.clients[me]).toEqual(wire(mock.room.clients[me]!)); // its own record, whole: assignment and all
      expect(room.clients[me]!.assignment).not.toBeNull();
      expect(roomLevel(room)).toEqual(roomLevel(host.last())); // the same room the host sees
      expect(room).toEqual(wire(playerRoomView(mock.room, me)));
    }
  });

  test("no other client's id or name is anywhere in anything a player is sent — from the first snapshot on", () => {
    for (const [me, s] of [[ANN, ann], [BEN, ben]] as const) {
      expect(s.states().length).toBeGreaterThan(1);
      // the very first one too: there is no fuller "initial state" for a joiner
      expect(Object.keys((JSON.parse(s.states()[0]!) as { room: RoomState }).room.clients)).toEqual([me]);
      for (const frame of s.frames) for (const other of others(me)) expect(frame.includes(other), `${me} was sent "${other}" in ${frame.slice(0, 60)}…`).toBe(false);
      expect(s.unparsable).toEqual([]);
    }
  });

  test("hosts, viewers and observers get the roster", async () => {
    const everyone = [HOST, ANN, BEN, SCREEN, SEEDED].sort();
    const observer = await joined(HOST, "host", false); // names the host's record without the key: a read-only seat
    await observer.next("ROOM_STATE");
    for (const s of [host, screen, observer]) {
      const room = s.last();
      expect(Object.keys(room.clients).sort()).toEqual(everyone);
      expect(room.hostClientIds).toEqual([HOST]);
      expect(room.hostConnected).toBe(true);
    }
    // and they stay on the full view for later publishes, not only the one sent on JOIN
    for (const s of [host, screen, observer]) s.forget(); // the room was UNISON before the setup, too
    host.send({ type: "SET_MODE", mode: "UNISON", params: {} });
    for (const s of [host, screen, observer]) {
      const m = await s.next("ROOM_STATE", (x) => x.room.mode.kind === "UNISON");
      expect(Object.keys(m.room.clients).sort()).toEqual(everyone);
    }
    observer.close();
  });

  test("calibration, as a player sees it: how many slots, which is its own, its own result — and whether it is the reference", async () => {
    host.send({ type: "CALIBRATION_START", referenceClientId: ANN }); // a player's phone listens
    const hostSees = (await host.next("ROOM_STATE", (m) => m.room.calibration.state === "countdown")).room.calibration;
    expect(hostSees.referenceClientId).toBe(ANN);
    expect(hostSees.order).toEqual([SEEDED, BEN]); // join order; the reference does not click

    const annSees = (await ann.next("ROOM_STATE", (m) => m.room.calibration.state === "countdown")).room.calibration;
    expect(annSees).toEqual({ ...hostSees, order: ["", ""], results: {} }); // the reference: told it is, and how many clicks
    const benSees = (await ben.next("ROOM_STATE", (m) => m.room.calibration.state === "countdown")).room.calibration;
    expect(benSees).toEqual({ ...hostSees, referenceClientId: null, order: ["", BEN], results: {} }); // "yours is the 2nd of 2"

    ann.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: BEN, residualMs: 4, confidence: 0.9 }] });
    const done = (await host.next("ROOM_STATE", (m) => m.room.calibration.state === "done")).room.calibration;
    expect(Object.keys(done.results)).toContain(BEN);
    const benDone = (await ben.next("ROOM_STATE", (m) => m.room.calibration.state === "done")).room.calibration;
    expect(benDone).toEqual({ state: "done", referenceClientId: null, startServerTime: done.startServerTime, order: [], results: { [BEN]: { residualMs: 4, confidence: 0.9 } } });
    const annDone = (await ann.next("ROOM_STATE", (m) => m.room.calibration.state === "done")).room.calibration;
    expect(annDone).toEqual({ state: "done", referenceClientId: ANN, startServerTime: done.startServerTime, order: [], results: {} });

    host.send({ type: "CALIBRATION_CANCEL" });
    const idle = (await ben.next("ROOM_STATE", (m) => m.room.calibration.state === "idle")).room.calibration;
    expect(idle).toEqual({ state: "idle", referenceClientId: null, startServerTime: null, order: [], results: {} });
    for (const other of others(BEN)) expect(ben.frames.some((f) => f.includes(other)), other).toBe(false);
  });

  // Last: it takes the host away.
  test("hostConnected is how a player learns the host left and came back (it has no roster to look in)", async () => {
    host.close();
    const away = await ann.next("ROOM_STATE", (m) => m.room.hostConnected === false);
    expect(away.room.hostClientIds).toEqual([]);
    expect(Object.keys(away.room.clients)).toEqual([ANN]);
    expect(mock.room.clients[HOST]!.connected).toBe(false); // the record is still there (retention), just not for a player

    ann.forget();
    host = await joined(HOST, "host");
    const back = await ann.next("ROOM_STATE", (m) => m.room.hostConnected === true);
    expect(Object.keys(back.room.clients)).toEqual([ANN]);
    expect(ann.frames.some((f) => f.includes(HOST))).toBe(false);
  });
});

describe("playerRoomView (pure)", () => {
  test("is a valid, self-contained ROOM_STATE that never aliases another client's data", () => {
    const view = playerRoomView(mock.room, ANN);
    expect(Object.keys(view.clients)).toEqual([ANN]);
    expect(view.hostClientIds).toEqual([]);
    expect(view.code).toBe(mock.room.code);
    expect(view.track).toEqual(mock.room.track);
    expect(view.transport).toEqual(mock.room.transport);
    expect(JSON.stringify(view).includes(BEN)).toBe(false);
  });
});
