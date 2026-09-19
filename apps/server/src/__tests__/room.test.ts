/**
 * B1: the WebSocket contract against the real server, with fake clients.
 * Modelled on packages/protocol/src/__tests__/mock-server.test.ts so the mock and the real server
 * are held to the same behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CALIBRATION_COUNTDOWN_MS, LEAD_MS, MAX_PLAYERS, PROTOCOL_VERSION, ROOM_STATE_MAX_HZ,
  parseServerMessage, type ClientMessage, type ServerMessage,
} from "@hive/protocol";
import { createServer } from "../server";

const PORT = 22080 + Math.floor(Math.random() * 900);
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const iosDevice = { userAgent: "test-ios", platform: "ios", browserFamily: "ios-safari" as const };

class Fake {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
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
  join(clientId: string, extra: Partial<Extract<ClientMessage, { type: "JOIN" }>> = {}) {
    this.send({
      type: "JOIN", clientId, roomCode: ROOM, kind: "player", plays: true, device,
      protocolVersion: PROTOCOL_VERSION, ...extra,
    });
  }
  next<T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    timeoutMs = 4000,
  ) {
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const p = (m: ServerMessage) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
      const hit = this.inbox.find(p);
      if (hit) return resolve(hit as Extract<ServerMessage, { type: T }>);
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: p,
        resolve: (m) => { clearTimeout(t); resolve(m as Extract<ServerMessage, { type: T }>); },
      });
    });
  }
  close() {
    this.ws.close();
  }
}

const ROOM = "TEST";
let hive: ReturnType<typeof createServer>;
let hostKey: string;
const opened: Fake[] = [];
const fake = () => {
  const f = new Fake();
  opened.push(f);
  return f;
};

beforeAll(async () => {
  hive = createServer({ port: PORT, roomFixedCode: ROOM, quiet: true });
  await hive.ready;
  hostKey = hive.rooms.get(ROOM)!.hostKey;
});
afterAll(() => {
  for (const f of opened) f.close();
  hive.stop();
});

describe("room WebSocket", () => {
  test("JOIN → WELCOME → snapshot; NTP has t1 ≤ t2; host sees HEALTH; a player cannot drive the transport", async () => {
    const host = fake();
    const p1 = fake();
    const p2 = fake();
    await Promise.all([host.open(), p1.open(), p2.open()]);

    host.join("host-000001", { kind: "host", plays: false, hostKey, name: "Host" });
    p1.join("play-000001", { name: "One" });
    p2.join("play-000002", { name: "Two", device: iosDevice });

    expect((await host.next("WELCOME")).isHost).toBe(true);
    const w1 = await p1.next("WELCOME");
    expect(w1.isHost).toBe(false);
    expect(w1.roomCode).toBe(ROOM);
    expect(w1.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(w1.serverTime).toBeGreaterThan(1_600_000_000_000);
    await p2.next("WELCOME");

    // NTP: t1 is stamped on receive, t2 on send, and the client's t0 comes back untouched.
    const t0 = performance.timeOrigin + performance.now();
    p1.send({ type: "NTP_REQUEST", t0, probeGroupId: 7, probeGroupIndex: 0 });
    const ntp = await p1.next("NTP_RESPONSE");
    expect(ntp.t0).toBe(t0);
    expect(ntp.t1).toBeLessThanOrEqual(ntp.t2);
    expect(ntp.probeGroupId).toBe(7);
    expect(ntp.probeGroupIndex).toBe(0);

    // The snapshot lists everyone; a non-playing host gets no assignment.
    const state = await host.next("ROOM_STATE", (m) => Object.keys(m.room.clients).length === 3);
    expect(state.room.hostClientIds).toEqual(["host-000001"]);
    expect(state.room.clients["host-000001"]!.assignment).toBeNull();
    expect(state.room.clients["play-000001"]!.assignment).not.toBeNull();
    expect(state.room.clients["play-000001"]!.joinIndex).toBe(1);
    // tableLatencyMs comes from the Tier-1 table via JOIN.device.browserFamily.
    expect(state.room.clients["play-000001"]!.tableLatencyMs).toBe(25); // desktop-chrome
    expect(state.room.clients["play-000002"]!.tableLatencyMs).toBe(60); // ios-safari
    expect(state.room.clients["play-000002"]!.assignment!.compensationMs).toBe(60);

    // HEALTH goes to hosts at 1 Hz and carries what CLIENT_STATUS reported.
    p1.send({ type: "CLIENT_STATUS", rttMs: 18, syncErrMs: 9, outputLatencyMs: 12, audioState: "ready" });
    const health = await host.next("HEALTH", (m) => m.clients["play-000001"]?.syncErrMs === 9, 2500);
    expect(health.clients["play-000001"]!.audioState).toBe("ready");
    expect(health.clients["play-000001"]!.rttMs).toBe(18);
    expect(health.clients["play-000001"]!.lastSeenServerTime).toBeGreaterThan(0);
    // players never receive HEALTH
    expect(p1.inbox.some((m) => m.type === "HEALTH")).toBe(false);

    p1.send({ type: "TRANSPORT", action: "PLAY" });
    expect((await p1.next("ERROR")).code).toBe("NOT_HOST");
  });

  test("SET_TRACK then PLAY puts track zero LEAD_MS ahead; PAUSE freezes the position", async () => {
    const host = fake();
    await host.open();
    host.join("host-000002", { kind: "host", plays: false, hostKey });
    await host.next("WELCOME");

    host.send({ type: "TRANSPORT", action: "PLAY" }); // no track yet
    expect((await host.next("ERROR", (m) => m.code === "NO_TRACK")).code).toBe("NO_TRACK");
    host.send({ type: "SET_TRACK", trackId: "no-such-track" });
    expect(host.inbox.filter((m) => m.type === "ERROR" && m.code === "NO_TRACK").length).toBeGreaterThan(0);

    host.send({ type: "SET_TRACK", trackId: "synthetic-60s" });
    const loaded = await host.next("ROOM_STATE", (m) => m.room.track?.id === "synthetic-60s");
    expect(loaded.room.track!.stems).toEqual(["drums", "bass", "vocals", "other"]);
    expect(loaded.room.transport.state).toBe("stopped");

    const before = performance.timeOrigin + performance.now();
    host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    const playing = await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
    if (playing.room.transport.state !== "playing") throw new Error("expected playing");
    const zero = playing.room.transport.serverTimeAtTrackZero;
    // zero = now + LEAD_MS: in the future, and within a few ms of the lead we asked for.
    expect(zero).toBeGreaterThan(before);
    expect(zero - before).toBeGreaterThanOrEqual(LEAD_MS - 5);
    expect(zero - before).toBeLessThan(LEAD_MS + 500);

    host.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec: 30 });
    const seeked = await host.next("ROOM_STATE", (m) =>
      m.room.transport.state === "playing" && m.room.transport.serverTimeAtTrackZero < zero);
    if (seeked.room.transport.state !== "playing") throw new Error("expected playing");
    // seeking 30 s in moves track zero 30 s into the past relative to a fresh PLAY
    expect(zero - seeked.room.transport.serverTimeAtTrackZero).toBeGreaterThan(29_000);

    host.send({ type: "TRANSPORT", action: "PAUSE" });
    const paused = await host.next("ROOM_STATE", (m) => m.room.transport.state === "paused");
    if (paused.room.transport.state !== "paused") throw new Error("expected paused");
    expect(paused.room.transport.trackTimeAtPause).toBeGreaterThan(29);
  });

  test("ROOM_STATE is coalesced to ROOM_STATE_MAX_HZ but the first change goes out immediately", async () => {
    const host = fake();
    await host.open();
    host.join("host-000003", { kind: "host", plays: false, hostKey });
    await host.next("WELCOME");
    await host.next("ROOM_STATE");
    // let the coalescer's window drain so the join's own trailing flush does not land mid-measurement
    await new Promise((r) => setTimeout(r, 1000 / ROOM_STATE_MAX_HZ + 100));

    const seenAt: number[] = [];
    const t0 = performance.now();
    host.ws.addEventListener("message", (ev) => {
      const m = parseServerMessage(String((ev as MessageEvent).data));
      if (m?.type === "ROOM_STATE") seenAt.push(performance.now() - t0);
    });
    // 12 mode changes back to back; the coalescer must not turn them into 12 broadcasts.
    for (let i = 0; i < 12; i++) host.send({ type: "SET_MODE", mode: i % 2 ? "UNISON" : "ORCHESTRA", params: {} });
    await new Promise((r) => setTimeout(r, 1200));

    const window = 1000 / ROOM_STATE_MAX_HZ;
    expect(seenAt.length).toBeGreaterThanOrEqual(1);
    expect(seenAt.length).toBeLessThanOrEqual(1200 / window + 1);
    expect(seenAt[0]).toBeLessThan(100); // leading edge: not parked on a 500 ms timer
    for (let i = 1; i < seenAt.length; i++) expect(seenAt[i]! - seenAt[i - 1]!).toBeGreaterThan(window - 50);
  });

  test("disconnect + rejoin with the same clientId keeps joinIndex, position, pin and nudge", async () => {
    const host = fake();
    const p = fake();
    await Promise.all([host.open(), p.open()]);
    host.join("host-000004", { kind: "host", plays: false, hostKey });
    p.join("play-keepme", { name: "Keeper" });
    await Promise.all([host.next("WELCOME"), p.next("WELCOME")]);
    const joined = await host.next("ROOM_STATE", (m) => !!m.room.clients["play-keepme"]);
    const joinIndex = joined.room.clients["play-keepme"]!.joinIndex;

    host.send({ type: "SET_POSITION", clientId: "play-keepme", x: 0.25, y: 0.75 });
    host.send({ type: "ASSIGN", clientId: "play-keepme", role: "bass" });
    host.send({ type: "NUDGE", clientId: "play-keepme", nudgeMs: 37 });
    const decorated = await host.next("ROOM_STATE", (m) => m.room.clients["play-keepme"]?.nudgeMs === 37);
    expect(decorated.room.clients["play-keepme"]!.position).toEqual({ x: 0.25, y: 0.75 });
    expect(decorated.room.clients["play-keepme"]!.pinnedRole).toBe("bass");
    // compensation = nudge + table(desktop-chrome = 25)
    expect(decorated.room.clients["play-keepme"]!.assignment!.compensationMs).toBe(62);

    p.close();
    await host.next("ROOM_STATE", (m) => m.room.clients["play-keepme"]?.connected === false);

    const back = fake();
    await back.open();
    back.join("play-keepme");
    await back.next("WELCOME");
    const restored = await back.next("ROOM_STATE", (m) => m.room.clients["play-keepme"]?.connected === true);
    const rec = restored.room.clients["play-keepme"]!;
    expect(rec.joinIndex).toBe(joinIndex);
    expect(rec.position).toEqual({ x: 0.25, y: 0.75 });
    expect(rec.pinnedRole).toBe("bass");
    expect(rec.nudgeMs).toBe(37);
    expect(rec.assignment!.compensationMs).toBe(62);
  });

  test("20 simultaneous joins all get WELCOME and appear in one snapshot in under 2 s", async () => {
    const host = fake();
    await host.open();
    host.join("host-000005", { kind: "host", plays: false, hostKey });
    await host.next("WELCOME");

    const n = 20;
    const clients = Array.from({ length: n }, () => fake());
    await Promise.all(clients.map((c) => c.open()));

    const started = performance.now();
    clients.forEach((c, i) => c.join(`burst-${String(i).padStart(2, "0")}`, { name: `B${i}` }));
    await Promise.all(clients.map((c) => c.next("WELCOME")));
    const snapshot = await host.next("ROOM_STATE", (m) =>
      Object.keys(m.room.clients).filter((id) => id.startsWith("burst-")).length === n);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2000);
    const burst = Object.values(snapshot.room.clients).filter((c) => c.id.startsWith("burst-"));
    expect(burst).toHaveLength(n);
    // joinIndex is unique and monotonic, so the planner's stem choice never reshuffles.
    expect(new Set(burst.map((c) => c.joinIndex)).size).toBe(n);
    expect(burst.every((c) => c.assignment !== null && c.connected)).toBe(true);
    console.log(`[B1] ${n} simultaneous joins → WELCOME + full snapshot in ${elapsedMs.toFixed(0)} ms`);
  });

  test("NUDGE from a player is allowed for itself and refused for anyone else", async () => {
    const a = fake();
    const b = fake();
    await Promise.all([a.open(), b.open()]);
    a.join("play-self");
    b.join("play-other");
    await Promise.all([a.next("WELCOME"), b.next("WELCOME")]);

    a.send({ type: "NUDGE", clientId: "play-self", nudgeMs: -12 });
    const own = await a.next("ROOM_STATE", (m) => m.room.clients["play-self"]?.nudgeMs === -12);
    expect(own.room.clients["play-self"]!.nudgeMs).toBe(-12);

    a.send({ type: "NUDGE", clientId: "play-other", nudgeMs: 50 });
    expect((await a.next("ERROR", (m) => m.code === "FORBIDDEN")).code).toBe("FORBIDDEN");
    expect(hive.rooms.get(ROOM)!.client("play-other")!.nudgeMs).toBe(0);
  });

  test("KICK removes the client and closes its socket", async () => {
    const host = fake();
    const victim = fake();
    await Promise.all([host.open(), victim.open()]);
    host.join("host-000006", { kind: "host", plays: false, hostKey });
    victim.join("play-victim");
    await Promise.all([host.next("WELCOME"), victim.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["play-victim"]);

    host.send({ type: "KICK", clientId: "play-victim" });
    expect((await victim.next("ERROR", (m) => m.code === "KICKED")).code).toBe("KICKED");
    await host.next("ROOM_STATE", (m) => !m.room.clients["play-victim"]);
    expect(hive.rooms.get(ROOM)!.client("play-victim")).toBeUndefined();
  });

  test("SET_PLAYS makes a host a speaker and gives it an assignment", async () => {
    const host = fake();
    await host.open();
    host.join("host-000007", { kind: "host", plays: false, hostKey });
    await host.next("WELCOME");
    const off = await host.next("ROOM_STATE", (m) => !!m.room.clients["host-000007"]);
    expect(off.room.clients["host-000007"]!.assignment).toBeNull();

    host.send({ type: "SET_PLAYS", plays: true });
    const on = await host.next("ROOM_STATE", (m) => m.room.clients["host-000007"]?.plays === true);
    expect(on.room.clients["host-000007"]!.assignment).not.toBeNull();
  });

  test("calibration: the plan skips the reference and non-playing clients; only the reference may report", async () => {
    const host = fake();
    const player = fake();
    const lurker = fake(); // a host that is not a speaker: never in `order`
    await Promise.all([host.open(), player.open(), lurker.open()]);
    host.join("host-cal", { kind: "host", plays: false, hostKey });
    lurker.join("host-cal-2", { kind: "host", plays: false, hostKey });
    player.join("play-cal");
    await Promise.all([host.next("WELCOME"), player.next("WELCOME"), lurker.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["play-cal"]);

    host.send({ type: "CALIBRATION_START", referenceClientId: "host-cal" });
    const plan = await host.next("CALIBRATION_PLAN");
    expect(plan.order).toContain("play-cal");
    expect(plan.order).not.toContain("host-cal");
    expect(plan.order).not.toContain("host-cal-2"); // plays:false → nothing to measure
    expect(plan.startServerTime).toBeGreaterThan(performance.timeOrigin + performance.now());
    expect(plan.clickSpec.chirpToHz).toBe(6000);

    const scheduled = await player.next("SCHEDULED_ACTION");
    expect(scheduled.action.kind).toBe("CALIBRATION_CLICK");
    // each phone clicks at start + its slot · interval, so the reference hears them one at a time
    const slot = plan.order.indexOf("play-cal");
    expect(scheduled.serverTimeToExecute).toBe(plan.startServerTime + slot * plan.intervalMs);
    const countdown = await host.next("ROOM_STATE", (m) => m.room.calibration.state === "countdown");
    expect(countdown.room.calibration.referenceClientId).toBe("host-cal");

    // a player may not report someone else's measurements
    player.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-cal", residualMs: 5, confidence: 0.9 }] });
    expect((await player.next("ERROR", (m) => m.code === "FORBIDDEN")).code).toBe("FORBIDDEN");

    await new Promise((r) => setTimeout(r, CALIBRATION_COUNTDOWN_MS + 50));
    host.send({
      type: "CALIBRATION_REPORT",
      measurements: [
        { clientId: "play-cal", residualMs: 12.5, confidence: 0.9 },
        { clientId: "host-cal-2", residualMs: 99, confidence: 0.2 }, // below the 0.5 cutoff → ignored
      ],
    });
    const done = await host.next("ROOM_STATE", (m) => m.room.calibration.state === "done");
    // calibratedOffsetMs = (null → tableLatencyMs 25) + 12.5
    expect(done.room.clients["play-cal"]!.calibratedOffsetMs).toBeCloseTo(37.5, 6);
    expect(done.room.clients["play-cal"]!.assignment!.compensationMs).toBeCloseTo(37.5, 6);
    expect(done.room.calibration.results["play-cal"]!.residualMs).toBe(12.5);
    expect(done.room.clients["host-cal-2"]!.calibratedOffsetMs).toBeNull();
  });

  test("bad messages, unknown rooms and pre-JOIN traffic are rejected without dropping the socket", async () => {
    const f = fake();
    await f.open();
    f.ws.send("not json at all");
    expect((await f.next("ERROR")).code).toBe("BAD_MESSAGE");

    f.send({ type: "SET_MODE", mode: "WAVE", params: {} }); // before JOIN
    expect((await f.next("ERROR", (m) => m.code === "NOT_JOINED")).code).toBe("NOT_JOINED");

    f.send({ type: "JOIN", clientId: "nope-0001", roomCode: "XXXX", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect((await f.next("ERROR", (m) => m.code === "NO_ROOM")).code).toBe("NO_ROOM");

    // the socket still works: a valid JOIN after the errors succeeds
    f.join("nope-0001");
    expect((await f.next("WELCOME")).clientId).toBe("nope-0001");
  });

  test("a host claim without the hostKey is demoted to a player", async () => {
    const f = fake();
    await f.open();
    f.join("play-fakehost", { kind: "host", plays: false, hostKey: "wrong-key" });
    const w = await f.next("WELCOME");
    expect(w.isHost).toBe(false);
    const state = await f.next("ROOM_STATE", (m) => !!m.room.clients["play-fakehost"]);
    expect(state.room.hostClientIds).not.toContain("play-fakehost");
    expect(state.room.clients["play-fakehost"]!.plays).toBe(true); // a player is always a speaker
  });

  test("MAX_PLAYERS is a real limit", () => {
    const room = hive.rooms.create("FULLRM"); // its own room: 64 fillers would pollute the shared one
    const socket = { send() {}, close() {} };
    const fill = MAX_PLAYERS - room.connectedPlayerCount();
    for (let i = 0; i < fill; i++) {
      expect(room.join(socket, { clientId: `filler-${i}`, kind: "player", plays: true, device }).ok).toBe(true);
    }
    const over = room.join(socket, { clientId: "one-too-many", kind: "player", plays: true, device });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("ROOM_FULL");
  });
});
