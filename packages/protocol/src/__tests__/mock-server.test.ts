import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CALIBRATION_COUNTDOWN_MS, PROTOCOL_VERSION } from "../constants";
import { parseServerMessage, type ClientMessage, type ServerMessage } from "../messages";
import { startMockServer } from "../mock-server";
import { CreateRoomRequestSchema, CreateRoomResponseSchema } from "../rest";

const PORT = 18080 + Math.floor(Math.random() * 1000);
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

class Fake {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  /** `port` so a test can drive its own server instance — the shared one always has a host already. */
  constructor(port: number = PORT) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = parseServerMessage(String(ev.data));
      if (!m) throw new Error(`unparsable server message: ${ev.data}`);
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    };
  }
  open() { return new Promise<void>((r) => (this.ws.readyState === 1 ? r() : (this.ws.onopen = () => r()))); }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
    /*
     * PROTO-12: a real phone decodes the room's track and says so, and the tuning moment only schedules
     * speakers that have (connected + AUDIO_READY for the current track) — on the real server always, on
     * the mock since it was brought into line. These tests used to join players that never announced
     * anything and still expected them in the calibration order; that was the mock's divergence, not
     * behaviour worth pinning. The assertions are unchanged — the fake player is simply a complete one.
     */
    if (m.type === "JOIN" && m.kind === "player") this.ws.send(JSON.stringify({ type: "AUDIO_READY", trackId: "synthetic-60s" } satisfies ClientMessage));
  }
  /**
   * Drop the inbox. `next()` searches history first, so a predicate that was ALSO true earlier in the
   * conversation (e.g. `calibratedOffsetMs === null`, true before anything was measured) resolves off a
   * stale snapshot and the test passes without the server having done anything. Call this immediately
   * before sending the message whose effect you are about to await.
   */
  forget() { this.inbox.length = 0; }
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
    expect(CreateRoomResponseSchema.safeParse(r).success).toBe(true);
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

describe("CALIBRATION_CANCEL (protocol v2)", () => {
  test("returns the room to idle, stops the countdown, and refuses a late report", async () => {
    const host = new Fake();
    const player = new Fake();
    await Promise.all([host.open(), player.open()]);
    host.send({ type: "JOIN", clientId: "cancel-host-1", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    player.send({ type: "JOIN", clientId: "cancel-play-1", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await Promise.all([host.next("WELCOME"), player.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["cancel-play-1"]);

    host.send({ type: "CALIBRATION_START", referenceClientId: "cancel-host-1" });
    // Match on the order contents, not just the state: an earlier test in this file leaves the shared
    // room mid-calibration, so a bare `state === "countdown"` matches that stale snapshot.
    const started = await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("cancel-play-1"));
    expect(started.room.calibration.state).toBe("countdown");
    expect(started.room.calibration.referenceClientId).toBe("cancel-host-1");
    // the player really was told to click, which is why cancelling has to be client-side too
    const scheduled = await player.next("SCHEDULED_ACTION");
    expect(scheduled.action.kind).toBe("CALIBRATION_CLICK");

    host.forget(); // the room was idle before this run too: only a fresh snapshot proves the cancel
    host.send({ type: "CALIBRATION_CANCEL" });
    const idle = await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");
    expect(idle.room.calibration.referenceClientId).toBeNull();
    expect(idle.room.calibration.order).toEqual([]);
    expect(idle.room.calibration.results).toEqual({});

    // a report that was already in flight must not write calibratedOffsetMs
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "cancel-play-1", residualMs: 25, confidence: 0.95 }] });
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.room.clients["cancel-play-1"]!.calibratedOffsetMs).toBeNull();
    expect(mock.room.calibration.state).toBe("idle");

    // and the cancelled countdown never advances to running
    await new Promise((r) => setTimeout(r, CALIBRATION_COUNTDOWN_MS));
    expect(mock.room.calibration.state).toBe("idle");
    host.ws.close();
    player.ws.close();
  }, 15_000);

  test("a player cannot cancel", async () => {
    const p = new Fake();
    await p.open();
    p.send({ type: "JOIN", clientId: "cancel-play-2", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await p.next("WELCOME");
    p.send({ type: "CALIBRATION_CANCEL" });
    expect((await p.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
    p.ws.close();
  });

  test("cancelling when nothing is running is harmless", async () => {
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "cancel-host-2", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await host.next("WELCOME");
    host.send({ type: "CALIBRATION_CANCEL" });
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.room.calibration.state).toBe("idle");
    host.ws.close();
  });
});

describe("P0-6 · the calibration accumulation base matches what the client was already subtracting", () => {
  test("a phone with no table row keeps its outputLatency in the base", async () => {
    // browserFamily "other" ⇒ tableLatencyMs null ⇒ the engine subtracts ctx.outputLatency itself, so the
    // residual was measured with it applied. Writing calibratedOffsetMs makes the engine STOP subtracting
    // it, so a base of 0 would leave the phone late by exactly its output latency until a second pass.
    const host = new Fake();
    const other = new Fake();
    await Promise.all([host.open(), other.open()]);
    host.send({ type: "JOIN", clientId: "p06-host-01", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    other.send({
      type: "JOIN", clientId: "p06-other-01", roomCode: "BZQ7", kind: "player", plays: true,
      device: { userAgent: "firefox", platform: "linux", browserFamily: "other" },
      protocolVersion: PROTOCOL_VERSION,
    });
    await Promise.all([host.next("WELCOME"), other.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["p06-other-01"]);
    expect(mock.room.clients["p06-other-01"]!.tableLatencyMs).toBeNull(); // the case under test

    // the phone reports the latency it is compensating for itself
    other.send({ type: "CLIENT_STATUS", rttMs: 20, syncErrMs: 10, outputLatencyMs: 30, audioState: "ready" });
    await host.next("HEALTH", (m) => m.clients["p06-other-01"]?.outputLatencyMs === 30, 2500);

    host.send({ type: "CALIBRATION_START", referenceClientId: "p06-host-01" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("p06-other-01"));
    // a perfectly synced phone measures residual 0 — and must STAY in sync after the report
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "p06-other-01", residualMs: 0, confidence: 0.95 }] });
    const done = await host.next("ROOM_STATE", (m) => typeof m.room.clients["p06-other-01"]?.calibratedOffsetMs === "number");

    const rec = done.room.clients["p06-other-01"]!;
    expect(rec.calibratedOffsetMs).toBe(30); // 30 (what it was subtracting) + 0 (residual), not 0
    // compensation is unchanged in effect: it used to subtract 30 itself, now the server supplies it
    expect(rec.assignment!.compensationMs).toBe(30);
    host.ws.close();
    other.ws.close();
  }, 15_000);

  test("a phone with a table row still accumulates on the table value", async () => {
    const host = new Fake();
    const ios = new Fake();
    await Promise.all([host.open(), ios.open()]);
    host.send({ type: "JOIN", clientId: "p06-host-02", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    ios.send({
      type: "JOIN", clientId: "p06-ios-0001", roomCode: "BZQ7", kind: "player", plays: true,
      device: { userAgent: "iphone", platform: "ios", browserFamily: "ios-safari" },
      protocolVersion: PROTOCOL_VERSION,
    });
    await Promise.all([host.next("WELCOME"), ios.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["p06-ios-0001"]);
    // it reports no live outputLatency (Safari often has none): the table row is what the engine subtracts
    ios.send({ type: "CLIENT_STATUS", rttMs: 20, syncErrMs: 10, outputLatencyMs: null, audioState: "ready" });
    await host.next("HEALTH", (m) => m.clients["p06-ios-0001"]?.rttMs === 20, 2500);

    host.send({ type: "CALIBRATION_START", referenceClientId: "p06-host-02" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("p06-ios-0001"));
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "p06-ios-0001", residualMs: -12, confidence: 0.9 }] });
    const done = await host.next("ROOM_STATE", (m) => typeof m.room.clients["p06-ios-0001"]?.calibratedOffsetMs === "number");
    expect(done.room.clients["p06-ios-0001"]!.calibratedOffsetMs).toBe(60 - 12); // ios-safari table row
    host.send({ type: "CALIBRATION_CANCEL" });
    host.ws.close();
    ios.ws.close();
  }, 15_000);

  test("PROTO-12 · a phone that reports a live outputLatency drops the table guess, and calibration accumulates on the live value", async () => {
    /*
     * This is the case the test above used to assert the opposite of ("even if it reports an
     * outputLatency, the table row wins", expecting 60 − 12). The real server changed that deliberately
     * (apps/server live-latency.test.ts): a reported ctx.outputLatency nulls tableLatencyMs — one-way —
     * so the phone subtracts its own live value and the guess leaves compensationMs in the same snapshot.
     * The mock had not followed, so the e2e suite ran against latency semantics production no longer has.
     */
    const host = new Fake();
    const android = new Fake();
    await Promise.all([host.open(), android.open()]);
    host.send({ type: "JOIN", clientId: "p06-host-03", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    android.send({
      type: "JOIN", clientId: "p06-live-0001", roomCode: "BZQ7", kind: "player", plays: true,
      device: { userAgent: "android", platform: "android", browserFamily: "android-chrome" },
      protocolVersion: PROTOCOL_VERSION,
    });
    await Promise.all([host.next("WELCOME"), android.next("WELCOME")]);
    const joined = await host.next("ROOM_STATE", (m) => !!m.room.clients["p06-live-0001"]?.assignment);
    expect(joined.room.clients["p06-live-0001"]!.tableLatencyMs).toBe(45);
    expect(joined.room.clients["p06-live-0001"]!.assignment!.compensationMs).toBe(45);

    // a zero or absent report changes nothing
    android.send({ type: "CLIENT_STATUS", rttMs: 20, syncErrMs: 10, outputLatencyMs: 0, audioState: "ready" });
    await host.next("HEALTH", (m) => m.clients["p06-live-0001"]?.outputLatencyMs === 0, 2500);
    expect(mock.room.clients["p06-live-0001"]!.tableLatencyMs).toBe(45);

    host.forget();
    android.send({ type: "CLIENT_STATUS", rttMs: 20, syncErrMs: 10, outputLatencyMs: 52, audioState: "ready" });
    const live = await host.next("ROOM_STATE", (m) => m.room.clients["p06-live-0001"]?.tableLatencyMs === null);
    expect(live.room.clients["p06-live-0001"]!.assignment!.compensationMs).toBe(0); // never both: the phone subtracts 52 itself

    host.send({ type: "CALIBRATION_START", referenceClientId: "p06-host-03" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("p06-live-0001"));
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "p06-live-0001", residualMs: 7, confidence: 0.9 }] });
    const done = await host.next("ROOM_STATE", (m) => typeof m.room.clients["p06-live-0001"]?.calibratedOffsetMs === "number");
    expect(done.room.clients["p06-live-0001"]!.calibratedOffsetMs).toBe(52 + 7);
    host.send({ type: "CALIBRATION_CANCEL" });
    host.ws.close();
    android.ws.close();
  }, 15_000);
});

describe("CALIBRATION_RESET (protocol v3)", () => {
  /*
   * The undo for a tuning moment that measured the wrong thing. It matters as a
   * distinct operation because of P0-6: a wrong `calibratedOffsetMs` is the accumulation base for the
   * next run, so "just calibrate again" carries the error forward. Cleared to `null`, never `0` — null
   * falls back to the Tier-1 table, zero claims the phone has no output latency.
   */
  test("CALIBRATION_RESET clears one client back to null, and its compensation falls back to the table", async () => {
    const host = new Fake();
    const ios = new Fake();
    await Promise.all([host.open(), ios.open()]);
    host.send({ type: "JOIN", clientId: "rst-host-001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    ios.send({
      type: "JOIN", clientId: "rst-ios-0001", roomCode: "BZQ7", kind: "player", plays: true,
      device: { userAgent: "iphone", platform: "ios", browserFamily: "ios-safari" },
      protocolVersion: PROTOCOL_VERSION,
    });
    await Promise.all([host.next("WELCOME"), ios.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["rst-ios-0001"]);

    // measure it badly: a sidelobe match 40 ms out
    host.send({ type: "CALIBRATION_START", referenceClientId: "rst-host-001" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("rst-ios-0001"));
    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "rst-ios-0001", residualMs: 40, confidence: 0.9 }] });
    await host.next("ROOM_STATE", (m) => m.room.clients["rst-ios-0001"]?.calibratedOffsetMs === 100); // 60 table + 40

    // a reset while the run is still `done` is refused: the report path and the reset would race
    host.send({ type: "CALIBRATION_RESET", clientId: "rst-ios-0001" });
    const busy = await host.next("ERROR", (m) => m.code === "CALIBRATION_BUSY");
    expect(busy.message).toContain("cancel first");
    expect(mock.room.clients["rst-ios-0001"]!.calibratedOffsetMs).toBe(100); // untouched

    host.forget();
    host.send({ type: "CALIBRATION_CANCEL" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");
    host.forget(); // `=== null` was also true before the run: only a FRESH snapshot proves the reset
    host.send({ type: "CALIBRATION_RESET", clientId: "rst-ios-0001" });
    const cleared = await host.next("ROOM_STATE", (m) => m.room.clients["rst-ios-0001"]?.calibratedOffsetMs === null);

    const rec = cleared.room.clients["rst-ios-0001"]!;
    expect(rec.calibratedOffsetMs).toBeNull(); // null, not 0
    expect(rec.assignment!.compensationMs).toBe(60); // straight back to the ios-safari table row
    host.ws.close();
    ios.ws.close();
  }, 15_000);

  test("CALIBRATION_RESET with no clientId clears the whole room, and is idempotent", async () => {
    const host = new Fake();
    const a = new Fake();
    const b = new Fake();
    await Promise.all([host.open(), a.open(), b.open()]);
    host.send({ type: "JOIN", clientId: "rst-host-002", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    a.send({ type: "JOIN", clientId: "rst-all-0001", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    b.send({ type: "JOIN", clientId: "rst-all-0002", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await Promise.all([host.next("WELCOME"), a.next("WELCOME"), b.next("WELCOME")]);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["rst-all-0002"]);

    host.send({ type: "CALIBRATION_START", referenceClientId: "rst-host-002" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.order.includes("rst-all-0002"));
    host.send({
      type: "CALIBRATION_REPORT",
      measurements: [
        { clientId: "rst-all-0001", residualMs: 7, confidence: 0.9 },
        { clientId: "rst-all-0002", residualMs: -9, confidence: 0.9 },
      ],
    });
    await host.next("ROOM_STATE", (m) => typeof m.room.clients["rst-all-0002"]?.calibratedOffsetMs === "number");
    host.forget();
    host.send({ type: "CALIBRATION_CANCEL" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");

    host.forget();
    host.send({ type: "CALIBRATION_RESET" });
    await host.next("ROOM_STATE", (m) => m.room.clients["rst-all-0002"]?.calibratedOffsetMs === null);
    // every client, not just the two this test measured
    for (const c of Object.values(mock.room.clients)) expect(c.calibratedOffsetMs).toBeNull();

    // idempotent: a second reset is not an error and changes nothing
    host.forget();
    host.send({ type: "CALIBRATION_RESET" });
    await host.next("ROOM_STATE", () => true);
    expect(mock.room.clients["rst-all-0001"]!.calibratedOffsetMs).toBeNull();
    expect(host.inbox.some((m) => m.type === "ERROR")).toBe(false);
    host.ws.close();
    a.ws.close();
    b.ws.close();
  }, 15_000);

  test("CALIBRATION_RESET is host-only and names an unknown client", async () => {
    const host = new Fake();
    const player = new Fake();
    await Promise.all([host.open(), player.open()]);
    host.send({ type: "JOIN", clientId: "rst-host-003", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    player.send({ type: "JOIN", clientId: "rst-play-001", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await Promise.all([host.next("WELCOME"), player.next("WELCOME")]);

    player.send({ type: "CALIBRATION_RESET" });
    expect((await player.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");

    host.send({ type: "CALIBRATION_RESET", clientId: "nobody-here" });
    expect((await host.next("ERROR", (m) => m.code === "NO_CLIENT")).message).toContain("nobody-here");
    host.ws.close();
    player.ws.close();
  }, 15_000);
});

describe("a phone with two sockets (a reconnect racing a retry)", () => {
  /*
   * The engine tries hard not to create this overlap (P0-4, and the reconnect-timer fix in transport.ts),
   * but the server must not *depend* on that: a close always races a JOIN on a bad network. The failure
   * this pins was silent from both ends — the phone stayed connected and kept playing while the server
   * marked it offline and stopped sending it anything targeted.
   */
  test("the orphan's close does not demote the live connection", async () => {
    const first = new Fake();
    await first.open();
    first.send({ type: "JOIN", clientId: "dup-client-01", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await first.next("WELCOME");

    // a second socket for the SAME client id, as a reconnect that raced a retry would produce
    const second = new Fake();
    await second.open();
    second.send({ type: "JOIN", clientId: "dup-client-01", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await second.next("WELCOME");
    expect(mock.room.clients["dup-client-01"]!.connected).toBe(true);

    // the orphan leaves; its close arrives after the new socket has already joined
    first.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.room.clients["dup-client-01"]!.connected).toBe(true);

    // and the live socket still receives what is addressed to it
    second.forget();
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "dup-host-0001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await host.next("WELCOME");
    host.send({ type: "CALIBRATION_START", referenceClientId: "dup-host-0001" });
    const click = await second.next("SCHEDULED_ACTION");
    expect(click.action.kind).toBe("CALIBRATION_CLICK");
    host.send({ type: "CALIBRATION_CANCEL" });

    second.ws.close();
    host.ws.close();
  }, 15_000);

  test("and the last socket to close really does mark it offline", async () => {
    const only = new Fake();
    await only.open();
    only.send({ type: "JOIN", clientId: "dup-client-02", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await only.next("WELCOME");
    expect(mock.room.clients["dup-client-02"]!.connected).toBe(true);
    only.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.room.clients["dup-client-02"]!.connected).toBe(false);
  }, 15_000);
});

describe("a viewer joins read-only (protocol v4, answers frontend R-13)", () => {
  /*
   * `/screen` is a projector display on a laptop at the venue, shown to a room full of people. It must
   * not need a `hostKey`, because a leaked one is full control — track, transport, KICK. Before `viewer`
   * existed, a no-key join could only land as `kind: "player", plays: true`, which inflated the player
   * count, consumed a stem in ORCHESTRA's rotation (the room loses an instrument to a laptop), and still
   * never received HEALTH — so the one number the display exists to show was unavailable.
   */
  test("no hostKey, never a speaker, not a player, and it still gets HEALTH", async () => {
    const viewer = new Fake();
    await viewer.open();
    viewer.send({
      type: "JOIN", clientId: "screen-000001", roomCode: "BZQ7", kind: "viewer", plays: true, // asks to play…
      device, protocolVersion: PROTOCOL_VERSION,
    });
    const welcome = await viewer.next("WELCOME");
    expect(welcome.isHost).toBe(false);

    const state = await viewer.next("ROOM_STATE", (m) => !!m.room.clients["screen-000001"]);
    const rec = state.room.clients["screen-000001"]!;
    expect(rec.kind).toBe("viewer");
    expect(rec.plays).toBe(false); // …and is refused: the field is a request, not a fact
    expect(rec.assignment).toBeNull(); // plan() gives a non-speaker nothing, so it cannot play audio
    expect(state.room.hostClientIds).not.toContain("screen-000001");

    // HEALTH is the whole point: the "Synced ±N ms" tile is a median over these numbers
    const h = await viewer.next("HEALTH", () => true, 2500);
    expect(typeof h.serverTime).toBe("number");
    expect(h.clients["screen-000001"]).toBeDefined();

    viewer.ws.close();
  }, 15_000);

  test("a viewer cannot drive the room", async () => {
    const viewer = new Fake();
    await viewer.open();
    viewer.send({ type: "JOIN", clientId: "screen-000002", roomCode: "BZQ7", kind: "viewer", plays: false, device, protocolVersion: PROTOCOL_VERSION });
    await viewer.next("WELCOME");
    viewer.forget();
    // every host-only handler gates on hostClientIds, which a viewer is never added to
    viewer.send({ type: "TRANSPORT", action: "PAUSE" });
    expect((await viewer.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
    viewer.send({ type: "KICK", clientId: "screen-000002" });
    expect((await viewer.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
    viewer.ws.close();
  }, 15_000);

  test("a viewer that claims to be a host without the key is not one", async () => {
    // the existing guard, re-asserted here because `viewer` adds a third branch to it
    const faker = new Fake();
    await faker.open();
    faker.send({ type: "JOIN", clientId: "screen-000003", roomCode: "BZQ7", kind: "host", plays: false, device, protocolVersion: PROTOCOL_VERSION });
    const welcome = await faker.next("WELCOME");
    expect(welcome.isHost).toBe(false);
    const state = await faker.next("ROOM_STATE", (m) => !!m.room.clients["screen-000003"]);
    expect(state.room.clients["screen-000003"]!.kind).toBe("player"); // no key, no viewer claim → player
    expect(state.room.clients["screen-000003"]!.plays).toBe(true);
    faker.ws.close();
  }, 15_000);
});


describe("owned uploads on the mock: everything is shared (contracts/library-scope.md)", () => {
  test("no track is `mine`, nothing can be removed, and a host JOIN carrying a libraryKey is accepted and ignored", async () => {
    const auth = { Authorization: `Bearer ${mock.hostKey}` };
    const list = await fetch(`http://localhost:${PORT}/tracks`, { headers: auth }).then((r) => r.json());
    expect(list.tracks.length).toBeGreaterThan(0);
    expect(list.tracks.some((t: { mine?: boolean }) => t.mine)).toBe(false);

    const shared = await fetch(`http://localhost:${PORT}/tracks/${list.tracks[0].id}`, { method: "DELETE", headers: auth });
    expect(shared.status).toBe(403);
    expect(await shared.json()).toEqual({ error: "not_owner" });
    expect((await fetch(`http://localhost:${PORT}/tracks/no-such-track`, { method: "DELETE", headers: auth })).status).toBe(404);
    const after = await fetch(`http://localhost:${PORT}/tracks`).then((r) => r.json());
    expect(after.tracks.length).toBe(list.tracks.length);

    // the browser may send DELETE and the Authorization header cross-origin
    const preflight = await fetch(`http://localhost:${PORT}/tracks/x`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    const libraryKey = "k".repeat(43);
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "lib-host-0001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, libraryKey, device, protocolVersion: PROTOCOL_VERSION });
    expect((await host.next("WELCOME")).isHost).toBe(true);
    const state = await host.next("ROOM_STATE", (m) => !!m.room.clients["lib-host-0001"]);
    expect(JSON.stringify(state)).not.toContain(libraryKey); // never broadcast
    host.ws.close();
  }, 15_000);
});

describe("the host key is the only way to be host (mirrors apps/server, audit SG-01 / SG-02)", () => {
  const post = (body: unknown) =>
    fetch(`http://localhost:${PORT}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("POST /rooms {code}: the key is echoed only to a caller that already presents it", async () => {
    const stranger = await post({ code: "BZQ7" });
    expect(stranger.status).toBe(403);
    const refused = await stranger.json();
    expect(refused).toEqual({ error: "NOT_HOST" });
    expect(JSON.stringify(refused)).not.toContain(mock.hostKey);

    const wrong = await post({ code: "bzq7", hostKey: "not-the-key" });
    expect(wrong.status).toBe(403);
    expect(JSON.stringify(await wrong.json())).not.toContain(mock.hostKey);

    const host = await post({ code: "BZQ7", hostKey: mock.hostKey });
    expect(host.status).toBe(200);
    expect((await host.json()).hostKey).toBe(mock.hostKey);

    const gone = await post({ code: "NOPE" });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({ error: "unknown room code" });

    // The request schema carries the key; the response schema allows the server's `restored` flag.
    expect(CreateRoomRequestSchema.safeParse({ code: "BZQ7", hostKey: mock.hostKey }).success).toBe(true);
    expect(CreateRoomResponseSchema.safeParse({ code: "BZQ7", hostKey: "k", joinUrl: "u", restored: true }).success).toBe(true);
  });

  test("a keyless JOIN that names the host's clientId is a read-only observer: it cannot act, displace or demote", async () => {
    // The host's id is public (ROOM_STATE.hostClientIds). Re-using it used to be a way in.
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "observed-host-1", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    expect((await host.next("WELCOME")).isHost).toBe(true);
    const before = JSON.stringify(mock.room.clients["observed-host-1"]);

    for (const kind of ["host", "player", "viewer"] as const) {
      const copycat = new Fake();
      await copycat.open();
      copycat.send({ type: "JOIN", clientId: "observed-host-1", roomCode: "BZQ7", kind, plays: true, device, protocolVersion: PROTOCOL_VERSION });
      expect((await copycat.next("WELCOME")).isHost).toBe(false);
      await copycat.next("ROOM_STATE"); // it may watch
      copycat.forget();
      copycat.send({ type: "SET_MODE", mode: "STROBE", params: {} });
      expect((await copycat.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
      copycat.forget();
      copycat.send({ type: "KICK", clientId: "observed-host-1" });
      expect((await copycat.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
      copycat.ws.close();
    }
    await new Promise((r) => setTimeout(r, 100)); // the copycats' closes are nobody's disconnect
    expect(JSON.stringify(mock.room.clients["observed-host-1"])).toBe(before);
    expect(mock.room.hostClientIds).toContain("observed-host-1");
    expect(mock.room.mode.kind).not.toBe("STROBE");
    // and the real host still has the room
    host.forget();
    host.send({ type: "SET_MODE", mode: "CHOIR", params: {} });
    await host.next("ROOM_STATE", (m) => m.room.mode.kind === "CHOIR");
    host.ws.close();
  }, 15_000);
});

describe("JOIN re-derives kind and plays on every join (R-16, mirrors apps/server's P0-2 tests)", () => {
  /*
   * The old code spread `...existing` and never consulted `wantsHost`, so a client demoted once could
   * never come back however many times it re-JOINed with the room's real key. `clientId` is persisted per
   * room code *independently of* `hostKey`, so that is the normal recovery path, not an edge case: a host
   * whose stored key went stale (a restart minted a new one) re-POSTs /rooms, gets the real key, re-JOINs
   * with the same id — and used to stay a player forever, with every host command answering NOT_HOST.
   */
  test("an existing player record is promoted to host once it presents the room's real hostKey", async () => {
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "promo-host-01", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await host.next("WELCOME");

    // it first lands as a plain player (what the demotion bug left behind)
    const demoted = new Fake();
    await demoted.open();
    demoted.send({ type: "JOIN", clientId: "promo-demoted-1", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    const first = await demoted.next("WELCOME");
    expect(first.isHost).toBe(false);
    await host.next("ROOM_STATE", (m) => !!m.room.clients["promo-demoted-1"]);
    expect(mock.room.clients["promo-demoted-1"]!.kind).toBe("player");
    const joinIndexBefore = mock.room.clients["promo-demoted-1"]!.joinIndex;

    // it learns the room's real key and re-JOINs with the SAME clientId
    const recovered = new Fake();
    await recovered.open();
    recovered.send({ type: "JOIN", clientId: "promo-demoted-1", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    const second = await recovered.next("WELCOME");

    expect(second.isHost).toBe(true); // WELCOME must agree with the record, or the UI shows the wrong screen
    const rec = mock.room.clients["promo-demoted-1"]!;
    expect(rec.kind).toBe("host");
    expect(rec.plays).toBe(false); // a host chooses; it asked not to be a speaker
    expect(rec.joinIndex).toBe(joinIndexBefore); // promoted in place, not a second record spliced in
    expect(mock.room.hostClientIds.filter((id) => id === "promo-demoted-1")).toHaveLength(1); // no duplicate
    // and it really has authority now
    recovered.forget();
    recovered.send({ type: "SET_MODE", mode: "ORCHESTRA", params: {} });
    await recovered.next("ROOM_STATE", (m) => m.room.mode.kind === "ORCHESTRA");

    host.ws.close();
    demoted.ws.close();
    recovered.ws.close();
  }, 15_000);

  test("an impostor claiming host with the wrong key is still refused while someone holds the room", async () => {
    const impostor = new Fake();
    await impostor.open();
    impostor.send({ type: "JOIN", clientId: "impostor-0001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: "wrong-key", device, protocolVersion: PROTOCOL_VERSION });
    const welcome = await impostor.next("WELCOME");
    expect(welcome.isHost).toBe(false);
    expect(mock.room.clients["impostor-0001"]!.kind).toBe("player");
    expect(mock.room.hostClientIds).not.toContain("impostor-0001");
    impostor.forget();
    impostor.send({ type: "KICK", clientId: "impostor-0001" });
    expect((await impostor.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");
    impostor.ws.close();
  }, 15_000);

  test("with nobody holding the room yet, a wrong key still does not get anyone in as host", async () => {
    // This test used to pin the opposite ("a stale key still gets the host in"): the vacant-host clause,
    // ported from apps/server for fixed-code demo rooms. The server dropped it (audit SG-02) because "no
    // host yet" is also true for every room before its host's first JOIN - any guest could take it - and
    // a host whose room was lost now gets it back with its own signed key instead. Expectation changed
    // deliberately. Needs its own server, because the shared one already has hosts.
    const port = 19_700 + Math.floor(Math.random() * 200);
    const fresh = startMockServer({ port, quiet: true, scenario: { players: [] } });
    await fresh.ready;
    try {
      expect(fresh.room.hostClientIds).toHaveLength(0);
      const host = new Fake(port);
      await host.open();
      host.send({ type: "JOIN", clientId: "respawn-host-1", roomCode: "BZQ7", kind: "host", plays: false, hostKey: "a-key-from-the-previous-life", device, protocolVersion: PROTOCOL_VERSION });
      const welcome = await host.next("WELCOME");
      expect(welcome.isHost).toBe(false);
      expect(fresh.room.clients["respawn-host-1"]!.kind).toBe("player");
      expect(fresh.room.hostClientIds).toHaveLength(0);
      host.ws.close();
    } finally {
      fresh.stop();
    }
  }, 15_000);

  test("a keyless JOIN cannot take host authority away either: a host id that asks to be a viewer only observes", async () => {
    /*
     * This test used to pin "a JOIN may drop privilege: the host record becomes a viewer and leaves
     * hostClientIds", on the reasoning that dropping privilege can never be an attack. It can: the host's
     * id is public, so anyone could demote the host by naming it. Like apps/server (SG-02), a keyless JOIN
     * that names a host record is now a read-only observer and the record is untouched. Expectation
     * changed deliberately.
     */
    const host = new Fake();
    await host.open();
    host.send({ type: "JOIN", clientId: "demote-me-0001", roomCode: "BZQ7", kind: "host", plays: false, hostKey: mock.hostKey, device, protocolVersion: PROTOCOL_VERSION });
    expect((await host.next("WELCOME")).isHost).toBe(true);
    expect(mock.room.hostClientIds).toContain("demote-me-0001");

    const asViewer = new Fake();
    await asViewer.open();
    asViewer.send({ type: "JOIN", clientId: "demote-me-0001", roomCode: "BZQ7", kind: "viewer", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    expect((await asViewer.next("WELCOME")).isHost).toBe(false);
    expect(mock.room.clients["demote-me-0001"]!.kind).toBe("host");
    expect(mock.room.hostClientIds).toContain("demote-me-0001");
    asViewer.forget();
    asViewer.send({ type: "TRANSPORT", action: "PAUSE" });
    expect((await asViewer.next("ERROR", (m) => m.code === "NOT_HOST")).code).toBe("NOT_HOST");

    host.ws.close();
    asViewer.ws.close();
  }, 15_000);

  test("a viewer id that later joins as a player gets plays back, or it would be silently silent", async () => {
    // /screen and /j share localStorage, so they share the persisted clientId. Inheriting "viewer" here
    // would leave a real phone in the room with no assignment and no sound, looking perfectly healthy.
    const screen = new Fake();
    await screen.open();
    screen.send({ type: "JOIN", clientId: "screen-then-p1", roomCode: "BZQ7", kind: "viewer", plays: false, device, protocolVersion: PROTOCOL_VERSION });
    await screen.next("WELCOME");
    expect(mock.room.clients["screen-then-p1"]!.plays).toBe(false);

    const player = new Fake();
    await player.open();
    player.send({ type: "JOIN", clientId: "screen-then-p1", roomCode: "BZQ7", kind: "player", plays: true, device, protocolVersion: PROTOCOL_VERSION });
    await player.next("WELCOME");
    const rec = mock.room.clients["screen-then-p1"]!;
    expect(rec.kind).toBe("player");
    expect(rec.plays).toBe(true);
    await player.next("ROOM_STATE", (m) => m.room.clients["screen-then-p1"]?.assignment !== null);
    expect(mock.room.clients["screen-then-p1"]!.assignment).not.toBeNull(); // it is a speaker again

    screen.ws.close();
    player.ws.close();
  }, 15_000);
});
