import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, RoomStateSchema, parseClientMessage, parseServerMessage, type ServerMessage } from "@hive/protocol";
import { MAX_MESSAGES_PER_SECOND, RoomManager, wireSafe, type Conn } from "../rooms";

/**
 * Audit SG-05: values the wire schema accepts that poison a room for everyone in it.
 * Before the fix (measured against HEAD a78b9e8):
 *  - a guest's `AUDIO_READY {trackId: <4 MB>}` was stored and every later ROOM_STATE was 4 MB;
 *  - `1e999` parses to Infinity, passes `z.number()`, and is serialised as `null`: a host PLAY with
 *    `trackTimeSec: 1e999`, or a guest's `CLIENT_STATUS {outputLatencyMs: 1e999}` followed by an
 *    honest tuning moment, left the room broadcasting ROOM_STATEs no client could parse.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
function fakeWs() {
  const sent: ServerMessage[] = [];
  let closed: [number?, string?] | null = null;
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: (c?: number, r?: string) => void (closed = [c, r]) } as unknown as WS;
  return { ws, sent, closed: () => closed };
}
const errors = (s: { sent: ServerMessage[] }) => s.sent.flatMap((m) => (m.type === "ERROR" ? [m.code] : []));

const manager = new RoomManager({ fixturesDir: "/nonexistent" });
manager.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
await manager.loadLibrary(); // → the single placeholder track "synthetic-60s"
const made: string[] = [];
afterAll(() => made.forEach((c) => manager.get(c)?.destroy()));

function party() {
  const r = manager.createRoom();
  if ("error" in r) throw new Error(r.error);
  made.push(r.code);
  const room = manager.get(r.code)!;
  const host = fakeWs();
  const guest = fakeWs();
  const join = (clientId: string, kind: "host" | "player") =>
    JSON.stringify({ type: "JOIN", clientId, roomCode: r.code, kind, plays: kind === "player", hostKey: kind === "host" ? r.hostKey : undefined, device, protocolVersion: PROTOCOL_VERSION });
  manager.handleMessage(host.ws, join("host-wire-0001", "host"));
  manager.handleMessage(guest.ws, join("play-wire-0001", "player"));
  manager.handleMessage(host.ws, JSON.stringify({ type: "SET_TRACK", trackId: "synthetic-60s" }));
  return { room, host, guest };
}
/** What a phone would do with the next broadcast. */
const clientsCanRead = (room: { room: unknown }) => parseServerMessage(JSON.stringify({ type: "ROOM_STATE", room: room.room })) !== null;

describe("SG-05: nothing a client sends can make ROOM_STATE unreadable or unbounded", () => {
  test("a guest's oversized AUDIO_READY.trackId is rejected, not stored and re-broadcast", () => {
    const { room, guest } = party();
    const size = () => JSON.stringify(room.room).length;
    const before = size();
    manager.handleMessage(guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "x".repeat(60_000) }));
    manager.handleMessage(guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "x".repeat(65) }));
    expect(errors(guest)).toEqual(["BAD_MESSAGE", "BAD_MESSAGE"]);
    expect(size()).toBe(before);
    expect(room.room.clients["play-wire-0001"]!.audioReadyTrackId).toBeNull();

    manager.handleMessage(guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "synthetic-60s" }));
    expect(room.room.clients["play-wire-0001"]!.audioReadyTrackId).toBe("synthetic-60s");
  });

  test("JSON 1e999 (Infinity) is refused in every numeric field instead of reaching room state", () => {
    const { room, host, guest } = party();
    // the premise: zod alone lets it through
    expect(parseClientMessage('{"type":"TRANSPORT","action":"PLAY","trackTimeSec":1e999}')).not.toBeNull();

    const poison = [
      '{"type":"TRANSPORT","action":"PLAY","trackTimeSec":1e999}',
      '{"type":"TRANSPORT","action":"SEEK","trackTimeSec":1e999}',
      '{"type":"CALIBRATION_REPORT","measurements":[{"clientId":"play-wire-0001","residualMs":1e999,"confidence":1}]}',
      '{"type":"CALIBRATION_REPORT","measurements":[{"clientId":"play-wire-0001","residualMs":-1e999,"confidence":1}]}',
      '{"type":"NTP_REQUEST","t0":1e999}',
      '{"type":"CLIENT_STATUS","rttMs":1e999,"syncErrMs":-1e999,"outputLatencyMs":1e999,"audioState":"ready"}',
    ];
    const before = JSON.stringify(room.room);
    for (const raw of poison) manager.handleMessage(host.ws, raw);
    for (const raw of poison) manager.handleMessage(guest.ws, raw);
    expect(errors(host)).toEqual(Array(poison.length).fill("BAD_MESSAGE"));
    expect(errors(guest)).toEqual(Array(poison.length).fill("BAD_MESSAGE"));
    expect(JSON.stringify(room.room)).toBe(before);
    expect(clientsCanRead(room)).toBe(true);
  });

  test("a guest cannot turn its own reported latency into a room-breaking calibration offset", () => {
    const { room, host, guest } = party();
    // finite but absurd, so it passes the Infinity check: still must not become the calibration base
    manager.handleMessage(guest.ws, JSON.stringify({ type: "CLIENT_STATUS", rttMs: 1, syncErrMs: 1, outputLatencyMs: 1e300, audioState: "ready" }));
    manager.handleMessage(guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "synthetic-60s" }));
    manager.handleMessage(host.ws, JSON.stringify({ type: "CALIBRATION_START", referenceClientId: "host-wire-0001" }));
    manager.handleMessage(host.ws, JSON.stringify({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-wire-0001", residualMs: 3, confidence: 0.9 }] }));

    const offset = room.room.clients["play-wire-0001"]!.calibratedOffsetMs!;
    expect(Number.isFinite(offset)).toBe(true);
    expect(Math.abs(offset)).toBeLessThan(200); // table guess (25) + residual (3), not 1e300
    expect(RoomStateSchema.safeParse(JSON.parse(JSON.stringify(room.room))).success).toBe(true);
    expect(clientsCanRead(room)).toBe(true);

    // and a sane reported latency is still honoured as the base (the behaviour the code documents)
    const second = party();
    manager.handleMessage(second.guest.ws, JSON.stringify({ type: "CLIENT_STATUS", rttMs: 1, syncErrMs: 1, outputLatencyMs: 80, audioState: "ready" }));
    manager.handleMessage(second.guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "synthetic-60s" }));
    manager.handleMessage(second.host.ws, JSON.stringify({ type: "CALIBRATION_START", referenceClientId: "host-wire-0001" }));
    manager.handleMessage(second.host.ws, JSON.stringify({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-wire-0001", residualMs: 3, confidence: 0.9 }] }));
    expect(second.room.room.clients["play-wire-0001"]!.calibratedOffsetMs).toBe(83);
  });

  test("an absurd calibration residual is ignored rather than applied", () => {
    const { room, host, guest } = party();
    manager.handleMessage(guest.ws, JSON.stringify({ type: "AUDIO_READY", trackId: "synthetic-60s" }));
    manager.handleMessage(host.ws, JSON.stringify({ type: "CALIBRATION_START", referenceClientId: "host-wire-0001" }));
    manager.handleMessage(host.ws, JSON.stringify({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-wire-0001", residualMs: 5_000_000, confidence: 1 }] }));
    expect(room.room.clients["play-wire-0001"]!.calibratedOffsetMs).toBeNull();
    expect(room.room.calibration.results["play-wire-0001"]).toBeUndefined();
  });

  test("wireSafe: finite numbers, bounded strings / ids / collections; ordinary messages pass", () => {
    expect(wireSafe({ type: "NUDGE", clientId: "a".repeat(64), nudgeMs: -100 })).toBe(true);
    expect(wireSafe({ type: "NUDGE", clientId: "a".repeat(65), nudgeMs: 0 })).toBe(false);
    expect(wireSafe({ device: { userAgent: "u".repeat(512) } })).toBe(true);
    expect(wireSafe({ device: { userAgent: "u".repeat(513) } })).toBe(false);
    expect(wireSafe({ n: Infinity })).toBe(false);
    expect(wireSafe({ n: -Infinity })).toBe(false);
    expect(wireSafe({ n: NaN })).toBe(false);
    expect(wireSafe({ params: { stemGainsDb: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`s${i}`, 0])) } })).toBe(false);
    expect(wireSafe({ params: { stemGainsDb: { ["k".repeat(65)]: 0 } } })).toBe(false);
    expect(wireSafe({ measurements: Array.from({ length: 513 }, () => ({ clientId: "c", residualMs: 0, confidence: 1 })) })).toBe(false);
    expect(wireSafe({ measurements: Array.from({ length: 256 }, () => ({ clientId: "c", residualMs: 0, confidence: 1 })), optional: undefined, nothing: null, flag: true })).toBe(true);
  });

  test(`a socket that sends more than ${MAX_MESSAGES_PER_SECOND} messages in a second is hung up on, and the excess is not processed`, () => {
    const { room, guest } = party();
    for (let i = 0; i < MAX_MESSAGES_PER_SECOND * 3; i++) {
      manager.handleMessage(guest.ws, JSON.stringify({ type: "NUDGE", clientId: "play-wire-0001", nudgeMs: (i % 100) + 1 }));
    }
    expect(guest.closed()).toEqual([1008, "rate limit"]);
    // the JOIN was this socket's first message, so exactly MAX − 1 NUDGEs were let through
    expect(room.room.clients["play-wire-0001"]!.nudgeMs).toBe(((MAX_MESSAGES_PER_SECOND - 2) % 100) + 1);
  });
});

describe("SG-05 on the real socket", () => {
  const PORT = 25080 + Math.floor(Math.random() * 900);
  let proc: ReturnType<typeof Bun.spawn>;
  beforeAll(async () => {
    proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env: { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", HOST_KEY_SECRET: "wire-guard-test-secret-0123456789abcdef" }, stdout: "ignore", stderr: "inherit" });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  });
  afterAll(() => proc.kill());

  test("a frame over 64 KB closes the connection; a normal-sized one is answered", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const reply = new Promise<string>((r) => (ws.onmessage = (e) => r(String(e.data))));
    ws.send("not json");
    expect(JSON.parse(await reply)).toMatchObject({ type: "ERROR", code: "BAD_MESSAGE" });

    const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
    ws.send(JSON.stringify({ type: "AUDIO_READY", trackId: "z".repeat(200_000) }));
    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    expect(code).not.toBe(-1);
  });
});
