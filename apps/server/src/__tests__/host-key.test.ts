import { afterAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ROOM_CODE_ALPHABET, type ServerMessage } from "@hive/protocol";
import { HOST_KEY_RESTORE_TTL_MS, HostKeys } from "../host-key";
import { RoomManager, type Conn } from "../rooms";

/**
 * Audit SG-01. `POST /rooms {code}` used to answer with the existing room's hostKey for anyone who
 * knew the 4-character code — i.e. every guest at the party could become the host. The key is now
 * only ever echoed to a caller who already holds it, and a signed key can re-create its own room
 * after the server lost it (restart / idle timeout) so a reload never strands the party.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const SECRET = "test-secret-test-secret-test-secret-0123";
const wallNow = () => performance.timeOrigin + performance.now();

function newManager(opts: { fixedCode?: string; hostKeySecret?: string } = {}) {
  const m = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: SECRET, ...opts });
  m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
  return m;
}
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const joinMsg = (clientId: string, roomCode: string, kind: "host" | "player", hostKey?: string) =>
  JSON.stringify({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION });
const ok = (r: ReturnType<RoomManager["createRoom"]>) => {
  if ("error" in r) throw new Error(`expected a room, got ${r.error}`);
  return r;
};
/** Every room a test leaves behind holds two intervals; destroy them so the test process can exit. */
const managers: RoomManager[] = [];
const tracked = (m: RoomManager) => (managers.push(m), m);
afterAll(() => {
  for (const m of managers) for (const code of [...(m as unknown as { rooms: Map<string, { destroy(): void }> }).rooms.keys()]) m.get(code)?.destroy();
});

describe("SG-01: POST /rooms never hands a hostKey to someone who does not already hold it", () => {
  test("knowing the code of a live room is not enough: no key comes back", () => {
    const m = tracked(newManager());
    const room = ok(m.createRoom());

    const attacker = m.createRoom(room.code);
    expect(attacker).toEqual({ error: "NOT_HOST", status: 403 });
    expect(JSON.stringify(attacker)).not.toContain(room.hostKey);

    expect(m.createRoom(room.code, "not-the-key")).toEqual({ error: "NOT_HOST", status: 403 });
    expect(m.createRoom(room.code.toLowerCase())).toEqual({ error: "NOT_HOST", status: 403 });
  });

  test("the host who already holds the key gets it echoed back (reload of /h/CODE keeps control)", () => {
    const m = tracked(newManager());
    const room = ok(m.createRoom());
    expect(m.createRoom(room.code, room.hostKey)).toEqual({ code: room.code, hostKey: room.hostKey });
    expect(m.createRoom(room.code.toLowerCase(), room.hostKey)).toEqual({ code: room.code, hostKey: room.hostKey });
  });

  test("a different server process with the same secret re-creates a vanished room under the same code and key", () => {
    const before = tracked(newManager());
    const room = ok(before.createRoom());

    const after = tracked(newManager()); // "the restart": no rooms, same HOST_KEY_SECRET
    expect(after.get(room.code)).toBeUndefined();
    const restored = after.createRoom(room.code, room.hostKey);
    expect(restored).toEqual({ code: room.code, hostKey: room.hostKey, restored: true });
    expect(after.get(room.code)!.hostKey).toBe(room.hostKey);
    // ...and from here it is an ordinary existing room again: nobody else can take it.
    expect(after.createRoom(room.code)).toEqual({ error: "NOT_HOST", status: 403 });
  });

  test("a vanished room cannot be squatted: made-up keys, keys for another code and expired keys all fail", () => {
    const before = tracked(newManager());
    const a = ok(before.createRoom());
    const b = ok(before.createRoom());
    const after = tracked(newManager());

    expect(after.createRoom(a.code)).toEqual({ error: "unknown room code", status: 400 });
    expect(after.createRoom(a.code, "00000000-0000-4000-8000-000000000000")).toEqual({ error: "unknown room code", status: 400 });
    expect(after.createRoom(a.code, b.hostKey)).toEqual({ error: "unknown room code", status: 400 }); // signed, but for another room
    const tampered = a.hostKey.slice(0, -1) + (a.hostKey.endsWith("A") ? "B" : "A");
    expect(after.createRoom(a.code, tampered)).toEqual({ error: "unknown room code", status: 400 });

    const otherSecret = tracked(newManager({ hostKeySecret: "a-completely-different-secret-9876543210" }));
    expect(otherSecret.createRoom(a.code, a.hostKey)).toEqual({ error: "unknown room code", status: 400 });
    expect(after.get(a.code)).toBeUndefined();
  });

  test("HostKeys.verify: bound to the code, to the secret, and to the restore window", () => {
    const keys = new HostKeys(SECRET);
    const t0 = 1_760_000_000_000;
    const key = keys.issue("BZQ7", t0);
    expect(key.length).toBeLessThanOrEqual(64); // JOIN.hostKey is z.string().max(64)
    expect(keys.verify("BZQ7", key, t0 + 1000)).toBe(true);
    expect(keys.verify("bzq7", key, t0 + 1000)).toBe(true);
    expect(keys.verify("BZQ8", key, t0 + 1000)).toBe(false);
    expect(keys.verify("BZQ7", key, t0 + HOST_KEY_RESTORE_TTL_MS + 1)).toBe(false);
    expect(keys.verify("BZQ7", key, t0 - 10 * 60_000)).toBe(false);
    expect(new HostKeys("another-secret-another-secret-123456").verify("BZQ7", key, t0 + 1000)).toBe(false);
    expect(new HostKeys().verify("BZQ7", key, t0 + 1000)).toBe(false); // no secret configured → random per process
    for (const junk of ["", "a.b", "a.b.c", "..", key + "x", "x".repeat(200), `${key}.${key}`]) expect(keys.verify("BZQ7", junk, t0)).toBe(false);
    expect(keys.issue("BZQ7", t0)).not.toBe(key); // nonce: two keys for one code never collide
  });

  test("only a code this server could have dealt can be restored", () => {
    const keys = new HostKeys(SECRET);
    const m = tracked(newManager());
    for (const code of ["AB", "ABCDE", "AB1D", "A/CD", "ABCDEFGH"]) {
      expect(m.createRoom(code, keys.issue(code, wallNow()))).toEqual({ error: "unknown room code", status: 400 });
    }
    const good = ROOM_CODE_ALPHABET.slice(0, 4);
    expect(m.createRoom(good, keys.issue(good, wallNow()))).toMatchObject({ code: good, restored: true });
  });
});

describe("SG-01: the host's own socket brings the room back (no page reload needed after a restart)", () => {
  test("JOIN kind:host with the signed key re-creates the room; the host is host again and players can follow", () => {
    const before = tracked(newManager());
    const room = ok(before.createRoom());
    const after = tracked(newManager());

    // A player's reconnect arrives first: the room is gone and a player cannot conjure it.
    const early = fakeWs();
    after.handleMessage(early.ws, joinMsg("player-early-01", room.code, "player"));
    expect(early.sent[0]).toMatchObject({ type: "ERROR", code: "NO_ROOM" });
    expect(after.get(room.code)).toBeUndefined();

    const host = fakeWs();
    after.handleMessage(host.ws, joinMsg("host-restore-01", room.code, "host", room.hostKey));
    expect(host.sent.find((x) => x.type === "WELCOME")).toMatchObject({ type: "WELCOME", isHost: true, roomCode: room.code });
    expect(after.get(room.code)!.hostKey).toBe(room.hostKey);

    const late = fakeWs();
    after.handleMessage(late.ws, joinMsg("player-late-001", room.code, "player"));
    expect(late.sent.find((x) => x.type === "WELCOME")).toMatchObject({ type: "WELCOME", isHost: false });
  });

  test("a JOIN with a forged key, or kind:player carrying a real key, re-creates nothing", () => {
    const before = tracked(newManager());
    const room = ok(before.createRoom());
    const after = tracked(newManager());

    const forged = fakeWs();
    after.handleMessage(forged.ws, joinMsg("host-forged-01", room.code, "host", "made-up-key"));
    expect(forged.sent[0]).toMatchObject({ type: "ERROR", code: "NO_ROOM" });

    const asPlayer = fakeWs();
    after.handleMessage(asPlayer.ws, joinMsg("player-key-0001", room.code, "player", room.hostKey));
    expect(asPlayer.sent[0]).toMatchObject({ type: "ERROR", code: "NO_ROOM" });
    expect(after.get(room.code)).toBeUndefined();
  });
});

describe("ROOM_FIXED_CODE stays a public single-room demo mode", () => {
  test("every call resolves to the fixed room and returns its key; other codes are still rejected", () => {
    const m = tracked(newManager({ fixedCode: "DEMO" }));
    const bare = ok(m.createRoom());
    expect(bare.code).toBe("DEMO");
    expect(m.createRoom("DEMO")).toEqual({ code: "DEMO", hostKey: bare.hostKey });
    expect(m.createRoom("demo", "whatever")).toEqual({ code: "DEMO", hostKey: bare.hostKey });
    expect(m.createRoom("NOPE")).toEqual({ error: "unknown room code", status: 400 });
  });

  test("after a restart the fixed room comes back under the key its host already holds", () => {
    const before = tracked(newManager({ fixedCode: "DEMO" }));
    const key = ok(before.createRoom()).hostKey;
    const after = tracked(newManager({ fixedCode: "DEMO" }));
    const host = fakeWs();
    after.handleMessage(host.ws, joinMsg("host-fixed-0001", "DEMO", "host", key));
    expect(after.get("DEMO")!.hostKey).toBe(key);
    expect(host.sent.find((x) => x.type === "WELCOME")).toMatchObject({ isHost: true });
  });
});
