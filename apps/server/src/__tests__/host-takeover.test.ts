import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

/**
 * Audit SG-02: becoming host took no key at all in two situations, both reachable by any guest.
 *   a) the room has no host record — true between POST /rooms and the host's first JOIN, and again
 *      DISCONNECT_RETENTION_MS (2 min) after the host's phone locks;
 *   b) the JOIN reuses the host's clientId, which every ROOM_STATE publishes.
 * Host is now granted by the hostKey alone, and checked per socket.
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
const join = (clientId: string, kind: "host" | "player" | "viewer", hostKey?: string): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: "TAKE",
  kind,
  plays: kind !== "viewer",
  hostKey,
  device,
  protocolVersion: PROTOCOL_VERSION,
});
const errors = (s: { sent: ServerMessage[] }) => s.sent.flatMap((m) => (m.type === "ERROR" ? [m.code] : []));

/** Every host-only message; none of them may change the room when sent by a non-host socket. */
const HOST_ONLY: ClientMessage[] = [
  { type: "SET_TRACK", trackId: "t" },
  { type: "TRANSPORT", action: "PLAY" },
  { type: "SET_MODE", mode: "STROBE", params: {} },
  { type: "ASSIGN", clientId: "real-host-0001", role: "drums" },
  { type: "SET_POSITION", clientId: "real-host-0001", x: 0.1, y: 0.9 },
  { type: "NUDGE", clientId: "real-host-0001", nudgeMs: 50 },
  { type: "SET_PLAYS", plays: true },
  { type: "KICK", clientId: "real-host-0001" },
  { type: "CALIBRATION_START", referenceClientId: "real-host-0001" },
  { type: "CALIBRATION_CANCEL" },
  { type: "CALIBRATION_RESET" },
  { type: "CALIBRATION_REPORT", measurements: [{ clientId: "real-host-0001", residualMs: 40, confidence: 1 }] },
];

describe("SG-02: only the hostKey grants host", () => {
  test("a) a keyless kind:'host' JOIN into a room with no host yet lands as a plain player", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const guest = fakeWs();
    room.join(guest.ws, join("guest-000001", "host"));
    expect(guest.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });
    expect(room.room.clients["guest-000001"]!.kind).toBe("player");
    expect(room.room.hostClientIds).toEqual([]);

    const wrongKey = fakeWs();
    room.join(wrongKey.ws, join("guest-000002", "host", "not-the-key"));
    expect(room.room.clients["guest-000002"]!.kind).toBe("player");

    room.handle(guest.ws, { type: "SET_TRACK", trackId: "t" });
    expect(errors(guest)).toEqual(["NOT_HOST"]);
    expect(room.room.track).toBeNull();

    // the real host arrives later and is the only host
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    expect(room.room.hostClientIds).toEqual(["real-host-0001"]);
    room.destroy();
  });

  test("a) after the host's record is gone, a guest still cannot claim the vacancy", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    room.handle(host.ws, { type: "KICK", clientId: "real-host-0001" }); // fastest way to an empty hostClientIds
    expect(room.room.hostClientIds).toEqual([]);

    const guest = fakeWs();
    room.join(guest.ws, join("guest-000001", "host"));
    expect(room.room.hostClientIds).toEqual([]);
    expect(room.room.clients["guest-000001"]!.kind).toBe("player");
    room.destroy();
  });

  test("b) a JOIN reusing the host's public clientId without the key gets a read-only seat and changes nothing", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const host = fakeWs();
    room.join(host.ws, join("real-host-0001", "host", room.hostKey));
    room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
    const before = JSON.stringify(room.room);

    for (const kind of ["player", "host", "viewer"] as const) {
      const impostor = fakeWs();
      room.join(impostor.ws, join("real-host-0001", kind, kind === "host" ? "wrong" : undefined));
      expect(impostor.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });
      expect(impostor.sent.some((m) => m.type === "ROOM_STATE")).toBe(true); // it may watch
      expect(room.sockets.get("real-host-0001")).toBe(host.ws); // …but it did not displace the host's socket

      for (const msg of HOST_ONLY) room.handle(impostor.ws, msg);
      expect(JSON.stringify(room.room)).toBe(before);
      expect(host.isClosed()).toBe(false);

      // its close is not the host's close
      room.disconnect(impostor.ws);
      expect(room.room.clients["real-host-0001"]!.connected).toBe(true);
    }

    // the real host is untouched and still in control
    room.handle(host.ws, { type: "SET_MODE", mode: "STROBE", params: {} });
    expect(room.room.mode.kind).toBe("STROBE");
    expect(errors(host)).toEqual([]);
    room.destroy();
  });

  test("privilege belongs to the socket that showed the key, not to the record", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    // A guest squats an id as a player while there is no host record under it…
    const squatter = fakeWs();
    room.join(squatter.ws, join("shared-id-0001", "player"));
    // …then the host joins under that same id with the key: the RECORD becomes host.
    const host = fakeWs();
    room.join(host.ws, { ...join("shared-id-0001", "host", room.hostKey), plays: false });
    expect(room.room.hostClientIds).toEqual(["shared-id-0001"]);

    // The squatter's socket still says "I am shared-id-0001" but never presented the key.
    room.handle(squatter.ws, { type: "SET_TRACK", trackId: "t" });
    room.handle(squatter.ws, { type: "SET_PLAYS", plays: true });
    expect(errors(squatter)).toEqual(["NOT_HOST"]);
    expect(room.room.track).toBeNull();
    expect(room.room.clients["shared-id-0001"]!.plays).toBe(false);

    room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
    expect(room.room.track?.id).toBe("t");
    room.destroy();
  });

  test("a keyed host reconnect and a keyed promotion still work", () => {
    const room = new Room("TAKE", fakeServer(), () => {}, library);
    const h1 = fakeWs();
    room.join(h1.ws, join("real-host-0001", "host", room.hostKey));
    room.disconnect(h1.ws);
    const h2 = fakeWs();
    room.join(h2.ws, join("real-host-0001", "host", room.hostKey));
    expect(h2.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: true });
    room.handle(h2.ws, { type: "SET_TRACK", trackId: "t" });
    expect(room.room.track?.id).toBe("t");

    const p = fakeWs();
    room.join(p.ws, join("player-000001", "player"));
    const p2 = fakeWs();
    room.join(p2.ws, join("player-000001", "host", room.hostKey));
    expect(room.room.hostClientIds).toEqual(["real-host-0001", "player-000001"]);
    room.destroy();
  });
});

/**
 * HOST-16 (found independently by host-ui, relayed by the coordinator), replayed over real sockets
 * against the real server process: a guest reads the host's client id out of ROOM_STATE.hostClientIds
 * and re-JOINs under it with kind:"host" and no key. On HEAD that answered WELCOME isHost:true and the
 * attacker's SET_MODE was applied.
 */
describe("SG-02 / HOST-16 over the wire", () => {
  const PORT = 23080 + Math.floor(Math.random() * 900);
  let proc: ReturnType<typeof Bun.spawn>;
  beforeAll(async () => {
    proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env: { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", HOST_KEY_SECRET: "host-16-test-secret-0123456789abcdef" }, stdout: "ignore", stderr: "inherit" });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  });
  afterAll(() => proc.kill());

  function open(joinFields: Record<string, unknown>, code: string) {
    const log: ServerMessage[] = [];
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const answered = new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "JOIN", roomCode: code, device, protocolVersion: PROTOCOL_VERSION, ...joinFields }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as ServerMessage;
        log.push(m);
        if (m.type === "WELCOME" || m.type === "ERROR") resolve();
      };
    });
    const until = async (pred: (m: ServerMessage) => boolean, ms = 3000) => {
      for (let waited = 0; waited < ms; waited += 25) {
        const hit = log.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timed out waiting for a message");
    };
    return { ws, log, answered, until };
  }

  test("the host's id is public, and it is worth nothing without the key", async () => {
    const { code, hostKey } = (await (await fetch(`http://localhost:${PORT}/rooms`, { method: "POST", body: "{}" })).json()) as { code: string; hostKey: string };
    const host = open({ clientId: "real-host-0001", kind: "host", plays: false, hostKey, name: "Host" }, code);
    await host.answered;
    const guest = open({ clientId: "attacker-as-player-1", kind: "player", plays: true, name: "Mallory" }, code);
    await guest.answered;
    // A phone is no longer told who the host is (it gets its own record and nothing else)…
    const mine = (await guest.until((m) => m.type === "ROOM_STATE")) as Extract<ServerMessage, { type: "ROOM_STATE" }>;
    expect(mine.room.hostClientIds).toEqual([]);
    expect(Object.keys(mine.room.clients)).toEqual(["attacker-as-player-1"]);
    // …but anyone can still read the roster by joining as a display, so the id stays public:
    const spy = open({ clientId: "attacker-as-viewer-1", kind: "viewer", plays: false }, code);
    await spy.answered;
    const state = (await spy.until((m) => m.type === "ROOM_STATE" && m.room.hostClientIds.length > 0)) as Extract<ServerMessage, { type: "ROOM_STATE" }>;
    const leakedHostId = state.room.hostClientIds[0]!;
    expect(leakedHostId).toBe("real-host-0001");

    for (const extra of [{}, { hostKey: "guess" }, { hostKey: "" }]) {
      const attacker = open({ clientId: leakedHostId, kind: "host", plays: false, name: "Mallory", ...extra }, code);
      await attacker.answered;
      expect(attacker.log.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });
      attacker.ws.send(JSON.stringify({ type: "SET_MODE", mode: "STROBE", params: {} }));
      attacker.ws.send(JSON.stringify({ type: "KICK", clientId: "attacker-as-player-1" }));
      attacker.ws.send(JSON.stringify({ type: "KICK", clientId: leakedHostId }));
      attacker.ws.send(JSON.stringify({ type: "PONG" })); // a marker: everything before it has been handled once NTP answers
      attacker.ws.send(JSON.stringify({ type: "NTP_REQUEST", t0: 1 }));
      await attacker.until((m) => m.type === "NTP_RESPONSE");
      expect(attacker.log.flatMap((m) => (m.type === "ERROR" ? [m.code] : []))).toEqual(["NOT_HOST", "NOT_HOST", "NOT_HOST"]);
      attacker.ws.close();
    }

    // the real host is still the only host, still connected, and the mode never moved
    host.ws.send(JSON.stringify({ type: "SET_MODE", mode: "WAVE", params: {} }));
    const after = (await spy.until((m) => m.type === "ROOM_STATE" && m.room.mode.kind !== "UNISON")) as Extract<ServerMessage, { type: "ROOM_STATE" }>;
    expect(after.room.mode.kind).toBe("WAVE"); // the host's change, not the attacker's STROBE
    expect(after.room.hostClientIds).toEqual(["real-host-0001"]);
    expect(after.room.clients["real-host-0001"]).toMatchObject({ kind: "host", connected: true });
    expect(after.room.clients["attacker-as-player-1"]).toMatchObject({ kind: "player" });
    expect(host.log.some((m) => m.type === "ERROR")).toBe(false);
    host.ws.close();
    guest.ws.close();
    spy.ws.close();
  });
});
