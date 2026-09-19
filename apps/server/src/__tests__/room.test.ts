import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type ServerMessage } from "@hive/protocol";

/** Boots the real server as a child process on a random port, same pattern as health.test.ts. */
const PORT = 21080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], {
    env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "http://localhost:3000", ROOM_FIXED_CODE: "" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

class Fake {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.onmessage = (ev) => {
      const m = parseServerMessage(String(ev.data));
      if (!m) throw new Error(`unparsable server message: ${ev.data}`);
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    };
  }
  open() {
    return new Promise<void>((r) => (this.ws.readyState === 1 ? r() : (this.ws.onopen = () => r())));
  }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 3000) {
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const p = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const hit = this.inbox.find(p);
      if (hit) return resolve(hit as Extract<ServerMessage, { type: T }>);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: p,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
}

async function createRoom(): Promise<{ code: string; hostKey: string }> {
  const r = await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json());
  return r;
}

describe("room manager (B1)", () => {
  test("JOIN → WELCOME → NTP → ROOM_STATE; host gets HEALTH; PLAY schedules ~LEAD_MS ahead; player TRANSPORT → NOT_HOST", async () => {
    const { code, hostKey } = await createRoom();
    const host = new Fake();
    const p1 = new Fake();
    const p2 = new Fake();
    await Promise.all([host.open(), p1.open(), p2.open()]);

    host.send({ type: "JOIN", clientId: "host-000001", roomCode: code, kind: "host", plays: false, hostKey, device, protocolVersion: PROTOCOL_VERSION });
    p1.send({ type: "JOIN", clientId: "play-000001", roomCode: code, kind: "player", plays: true, name: "One", device, protocolVersion: PROTOCOL_VERSION });
    p2.send({ type: "JOIN", clientId: "play-000002", roomCode: code, kind: "player", plays: true, name: "Two", device, protocolVersion: PROTOCOL_VERSION });

    const w = await host.next("WELCOME");
    expect(w.isHost).toBe(true);
    expect((await p1.next("WELCOME")).isHost).toBe(false);

    const t0 = performance.timeOrigin + performance.now();
    p1.send({ type: "NTP_REQUEST", t0, probeGroupId: 1, probeGroupIndex: 0 });
    const ntp = await p1.next("NTP_RESPONSE");
    expect(ntp.t0).toBe(t0);
    expect(ntp.t1).toBeLessThanOrEqual(ntp.t2);

    const state = await host.next("ROOM_STATE", (m) => Object.values(m.room.clients).filter((c) => c.kind === "player").length === 2);
    expect(state.room.hostClientIds).toContain("host-000001");
    expect(state.room.clients["host-000001"]!.assignment).toBeNull(); // host with plays:false
    expect(state.room.clients["play-000001"]!.assignment).not.toBeNull();

    const health = await host.next("HEALTH", undefined, 2500);
    expect(Object.keys(health.clients)).toContain("play-000001");

    // player attempts a host-only action
    p1.send({ type: "TRANSPORT", action: "PLAY" });
    expect((await p1.next("ERROR")).code).toBe("NOT_HOST");

    // host sets a track and plays it: serverTimeAtTrackZero ≈ now + LEAD_MS (600ms)
    host.send({ type: "SET_TRACK", trackId: "synthetic-60s" });
    await host.next("ROOM_STATE", (m) => m.room.track?.id === "synthetic-60s");
    const beforePlay = performance.timeOrigin + performance.now();
    host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    const playing = await p1.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
    expect(playing.room.transport.state).toBe("playing");
    if (playing.room.transport.state === "playing") {
      const delta = playing.room.transport.serverTimeAtTrackZero - beforePlay;
      expect(delta).toBeGreaterThan(400); // LEAD_MS=600, allow slack for network/process overhead
      expect(delta).toBeLessThan(1500);
    }

    host.ws.close();
    p1.ws.close();
    p2.ws.close();
  });

  test("rejoin with the same clientId keeps joinIndex", async () => {
    const { code, hostKey } = await createRoom();
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "host-rejoin-a", roomCode: code, kind: "host", plays: false, hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await host.next("WELCOME");

    const p1 = new Fake();
    await p1.open();
    p1.send({ type: "JOIN", clientId: "play-rejoin-a", roomCode: code, kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const first = await host.next("ROOM_STATE", (m) => !!m.room.clients["play-rejoin-a"]);
    const joinIndex = first.room.clients["play-rejoin-a"]!.joinIndex;
    p1.ws.close();

    await host.next("ROOM_STATE", (m) => m.room.clients["play-rejoin-a"]?.connected === false);

    const p1b = new Fake();
    await p1b.open();
    p1b.send({ type: "JOIN", clientId: "play-rejoin-a", roomCode: code, kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const back = await host.next("ROOM_STATE", (m) => m.room.clients["play-rejoin-a"]?.connected === true);
    expect(back.room.clients["play-rejoin-a"]!.joinIndex).toBe(joinIndex);

    host.ws.close();
    p1b.ws.close();
  });

  test("20 simultaneous joins settle in under 2 seconds", async () => {
    const { code, hostKey } = await createRoom();
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "host-load", roomCode: code, kind: "host", plays: false, hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await host.next("WELCOME");

    const clients = Array.from({ length: 20 }, () => new Fake());
    await Promise.all(clients.map((c) => c.open()));
    const start = performance.now();
    clients.forEach((c, i) =>
      c.send({ type: "JOIN", clientId: `load-${String(i).padStart(3, "0")}`, roomCode: code, kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION }),
    );
    await host.next("ROOM_STATE", (m) => Object.values(m.room.clients).filter((c) => c.kind === "player").length === 20, 5000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000);

    host.ws.close();
    clients.forEach((c) => c.ws.close());
  });

  test("two different rooms are isolated from each other", async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a.code).not.toBe(b.code);

    const hostA = new Fake();
    const hostB = new Fake();
    await Promise.all([hostA.open(), hostB.open()]);
    hostA.send({ type: "JOIN", clientId: "host-iso-a", roomCode: a.code, kind: "host", plays: false, hostKey: a.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    hostB.send({ type: "JOIN", clientId: "host-iso-b", roomCode: b.code, kind: "host", plays: false, hostKey: b.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await Promise.all([hostA.next("WELCOME"), hostB.next("WELCOME")]);

    hostA.send({ type: "SET_TRACK", trackId: "synthetic-60s" });
    const stateA = await hostA.next("ROOM_STATE", (m) => m.room.track?.id === "synthetic-60s");
    expect(stateA.room.code).toBe(a.code);
    expect(Object.keys(stateA.room.clients)).toEqual(["host-iso-a"]);

    hostA.ws.close();
    hostB.ws.close();
  });
});
