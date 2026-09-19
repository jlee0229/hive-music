import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../constants";
import { parseServerMessage, type ClientMessage, type ServerMessage } from "../messages";
import { startMockServer } from "../mock-server";

const PORT = 18080 + Math.floor(Math.random() * 1000);
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

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
  open() { return new Promise<void>((r) => (this.ws.readyState === 1 ? r() : (this.ws.onopen = () => r()))); }
  send(m: ClientMessage) { this.ws.send(JSON.stringify(m)); }
  next<T extends ServerMessage["type"]>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 3000) {
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const p = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const hit = this.inbox.find(p);
      if (hit) return resolve(hit as Extract<ServerMessage, { type: T }>);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({ pred: p, resolve: (m) => { clearTimeout(t); resolve(m as Extract<ServerMessage, { type: T }>); } });
    });
  }
}

let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [{ name: "Mock", browserFamily: "ios-safari", position: [0.5, 0.5], health: "good", pinnedRole: null }] } });
  await mock.ready;
});
afterAll(() => mock.stop());

describe("mock server", () => {
  test("REST: /health, /rooms, /tracks", async () => {
    const h = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json());
    expect(h.ok).toBe(true);
    expect(h.protocolVersion).toBe(PROTOCOL_VERSION);
    const r = await fetch(`http://localhost:${PORT}/rooms`, { method: "POST" }).then((r) => r.json());
    expect(r.code).toBe("BZQ7");
    expect(typeof r.hostKey).toBe("string");
    const t = await fetch(`http://localhost:${PORT}/tracks?q=syn`).then((r) => r.json());
    expect(t.tracks.length).toBeGreaterThan(0);
    expect(t.tracks[0].stems).toContain("drums");
  });

  test("JOIN → WELCOME → NTP → ROOM_STATE; host gets HEALTH; play moves the transport", async () => {
    const host = new Fake();
    const p1 = new Fake();
    const p2 = new Fake();
    await Promise.all([host.open(), p1.open(), p2.open()]);
    host.send({ type: "JOIN", clientId: "host-000001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    p1.send({ type: "JOIN", clientId: "play-000001", roomCode: "BZQ7", kind: "player", plays: true, name: "One", device, protocolVersion: PROTOCOL_VERSION });
    p2.send({ type: "JOIN", clientId: "play-000002", roomCode: "BZQ7", kind: "player", plays: true, name: "Two", device, protocolVersion: PROTOCOL_VERSION });
    const w = await host.next("WELCOME");
    expect(w.isHost).toBe(true);
    expect((await p1.next("WELCOME")).isHost).toBe(false);

    const t0 = performance.timeOrigin + performance.now();
    p1.send({ type: "NTP_REQUEST", t0, probeGroupId: 1, probeGroupIndex: 0 });
    const ntp = await p1.next("NTP_RESPONSE");
    expect(ntp.t0).toBe(t0);
    expect(ntp.t1).toBeLessThanOrEqual(ntp.t2);

    const state = await host.next("ROOM_STATE", (m) => Object.values(m.room.clients).filter((c) => c.kind === "player").length === 3);
    expect(state.room.hostClientIds).toContain("host-000001");
    expect(state.room.clients["host-000001"]!.assignment).toBeNull();
    expect(state.room.clients["play-000001"]!.assignment).not.toBeNull();
    expect(state.room.track?.id).toBe("synthetic-60s");

    const health = await host.next("HEALTH", undefined, 2500);
    expect(Object.keys(health.clients)).toContain("play-000001");

    host.send({ type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    const orch = await p2.next("ROOM_STATE", (m) => m.room.mode.kind === "ORCHESTRA");
    const labels = new Set(Object.values(orch.room.clients).filter((c) => c.plays).map((c) => c.assignment!.label));
    expect(labels.size).toBeGreaterThan(1);

    host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    const playing = await p1.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
    expect(playing.room.transport.state).toBe("playing");

    p1.send({ type: "TRANSPORT", action: "PAUSE" }); // not host → ERROR
    expect((await p1.next("ERROR")).code).toBe("NOT_HOST");

    host.send({ type: "CALIBRATION_START", referenceClientId: "host-000001" });
    const plan = await host.next("CALIBRATION_PLAN");
    expect(plan.order).toContain("play-000001");
    const click = await p1.next("SCHEDULED_ACTION");
    expect(click.action.kind).toBe("CALIBRATION_CLICK");

    // reconnect with the same clientId keeps the slot
    p2.ws.close();
    const p2b = new Fake();
    await p2b.open();
    p2b.send({ type: "JOIN", clientId: "play-000002", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const back = await p2b.next("ROOM_STATE", (m) => m.room.clients["play-000002"]?.connected === true);
    expect(back.room.clients["play-000002"]!.joinIndex).toBe(state.room.clients["play-000002"]!.joinIndex);
    host.ws.close(); p1.ws.close(); p2b.ws.close();
  });
});
