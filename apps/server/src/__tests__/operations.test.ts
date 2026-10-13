import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { CLOSE_SERVICE_RESTART, ROOM_UNCLAIMED_TTL_MS, Room, RoomManager, STATE_HEARTBEAT_MS, type Conn } from "../rooms";
import { ownerIdOf } from "../library";
import { handleDeleteTrack, handleUploadTracks } from "../upload/route";
import { encodeMonoWav16 } from "../upload/wav";

/**
 * Wave 2 item 7 — surviving a deploy and being able to see what the server is doing:
 * a state heartbeat while playing (ENGINE-SYNC-P5), a clean shutdown that tells every socket to
 * reconnect (INFRA-05/16), counts on /health (SCALE-NET-08), and an operator's log.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
function fakeWs() {
  const sent: ServerMessage[] = [];
  let closed: [number?, string?] | null = null;
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => void sent.push(JSON.parse(raw)), subscribe: () => {}, close: (c?: number, r?: string) => void (closed ??= [c, r]) } as unknown as WS;
  return { ws, sent, closed: () => closed, states: () => sent.filter((m) => m.type === "ROOM_STATE").length };
}
const joinMsg = (clientId: string, roomCode: string, kind: "host" | "player" | "viewer", hostKey?: string, libraryKey?: string): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode,
  kind,
  plays: kind === "player",
  hostKey,
  libraryKey,
  device,
  protocolVersion: PROTOCOL_VERSION,
});

describe("ENGINE-SYNC-P5: a playing room repeats its state to anyone who has heard nothing for a while", () => {
  test("every recipient gets the current ROOM_STATE again about every 5 s while playing — and only while playing", () => {
    jest.useFakeTimers();
    try {
      const room = new Room("BEAT", { publish: () => {} } as unknown as Bun.Server<Conn>, () => {}, () => [{ id: "t", title: "t", durationSec: 600, stems: ["mix"] }]);
      const host = fakeWs();
      const phone = fakeWs();
      const viewer = fakeWs();
      room.join(host.ws, joinMsg("host-beat-0001", "BEAT", "host", room.hostKey));
      room.join(phone.ws, joinMsg("play-beat-0001", "BEAT", "player"));
      room.join(viewer.ws, joinMsg("view-beat-0001", "BEAT", "viewer"));
      room.handle(host.ws, { type: "SET_TRACK", trackId: "t" });
      jest.advanceTimersByTime(20_000); // stopped: nothing to keep in step
      const idle = [host.states(), phone.states(), viewer.states()];
      jest.advanceTimersByTime(20_000);
      expect([host.states(), phone.states(), viewer.states()]).toEqual(idle);

      room.handle(host.ws, { type: "TRANSPORT", action: "PLAY" });
      jest.advanceTimersByTime(1000);
      const playing = [host.states(), phone.states(), viewer.states()];
      const lastBefore = phone.sent.filter((m) => m.type === "ROOM_STATE").at(-1);
      jest.advanceTimersByTime(4 * STATE_HEARTBEAT_MS + 1500); // 21.5 s of an uneventful song
      const beats = [host.states() - playing[0]!, phone.states() - playing[1]!, viewer.states() - playing[2]!];
      for (const n of beats) {
        expect(n).toBeGreaterThanOrEqual(4);
        expect(n).toBeLessThanOrEqual(5); // a heartbeat, not a stream
      }
      expect(phone.sent.filter((m) => m.type === "ROOM_STATE").at(-1)).toEqual(lastBefore!); // the same state, said again

      // a recipient that was just told something is not told again until it has been quiet for 5 s
      room.handle(host.ws, { type: "NUDGE", clientId: "play-beat-0001", nudgeMs: 9 });
      jest.advanceTimersByTime(600);
      const afterChange = phone.states();
      jest.advanceTimersByTime(STATE_HEARTBEAT_MS - 1700);
      expect(phone.states()).toBe(afterChange);
      jest.advanceTimersByTime(2500);
      expect(phone.states()).toBe(afterChange + 1);

      room.handle(host.ws, { type: "TRANSPORT", action: "PAUSE" });
      jest.advanceTimersByTime(1000);
      const paused = phone.states();
      jest.advanceTimersByTime(30_000);
      expect(phone.states()).toBe(paused);
      room.destroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("INFRA-05/16: shutdown tells every socket to reconnect", () => {
  test("manager.shutdown() closes joined, duplicate, observing and held sockets with 1012 and leaves no room or timer behind", () => {
    jest.useFakeTimers();
    try {
      const m = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: "operations-test-secret-0123456789abcdef" });
      m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
      const a = m.createRoom();
      const gone = m.createRoom();
      if ("error" in a || "error" in gone) throw new Error("no room");
      jest.advanceTimersByTime(1); // `gone` will be asked for after it has been collected:
      m.get(gone.code)!.destroy();
      (m as unknown as { rooms: Map<string, Room> }).rooms.delete(gone.code);

      const host = fakeWs();
      const phone = fakeWs();
      const phoneOtherTab = fakeWs();
      const observer = fakeWs();
      const held = fakeWs();
      m.handleMessage(host.ws, JSON.stringify(joinMsg("host-stop-0001", a.code, "host", a.hostKey)));
      m.handleMessage(phone.ws, JSON.stringify(joinMsg("play-stop-0001", a.code, "player")));
      m.handleMessage(phoneOtherTab.ws, JSON.stringify(joinMsg("play-stop-0001", a.code, "player")));
      m.handleMessage(observer.ws, JSON.stringify(joinMsg("host-stop-0001", a.code, "viewer"))); // the host's id, no key
      m.handleMessage(held.ws, JSON.stringify(joinMsg("play-stop-0002", gone.code, "player"))); // waiting for a room (SG-15)
      expect(m.parkedCount).toBe(1);
      expect(m.stats()).toEqual({ rooms: 1, playing: 0, clients: 2 });

      expect(m.shutdown()).toBe(5);
      for (const s of [host, phone, phoneOtherTab, observer, held]) expect(s.closed()).toEqual([CLOSE_SERVICE_RESTART, "server restarting"]);
      expect(m.stats()).toEqual({ rooms: 0, playing: 0, clients: 0 });
      expect(m.parkedCount).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("the operator's log", () => {
  test("one line per room created / restored / ended and per upload accepted / refused / removed — and never a key or an owner id", async () => {
    const fixtures = mkdtempSync(join(tmpdir(), "hive-ops-log-"));
    const lines: string[] = [];
    const LIBRARY_KEY = "operations-library-key-0123456789abcdefghij";
    try {
      jest.useFakeTimers();
      const m = new RoomManager({ fixturesDir: fixtures, hostKeySecret: "operations-test-secret-0123456789abcdef", log: (l) => void lines.push(l) });
      m.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
      await m.loadLibrary();
      const room = m.createRoom();
      if ("error" in room) throw new Error(room.error);
      const forgotten = m.createRoom();
      if ("error" in forgotten) throw new Error(forgotten.error);
      const host = fakeWs();
      m.handleMessage(host.ws, JSON.stringify(joinMsg("host-logs-0001", room.code, "host", room.hostKey, LIBRARY_KEY)));
      jest.advanceTimersByTime(ROOM_UNCLAIMED_TTL_MS + 1000); // nobody ever joined `forgotten`
      m.createRoom(forgotten.code, forgotten.hostKey); // …and its host comes back
      jest.useRealTimers();

      const tone = new Float32Array(44100 * 2).map((_, i) => Math.sin(i / 30) * 0.4);
      const upload = (bytes: Uint8Array) => {
        const form = new FormData();
        form.set("title", "Logged");
        form.set("mix", new File([bytes as unknown as BlobPart], "mix.wav"));
        return handleUploadTracks(new Request("http://hive.test/tracks", { method: "POST", body: form, headers: { authorization: `Bearer ${room.hostKey}` } }), m, fixtures, "http://hive.test", {});
      };
      const ok = (await (await upload(encodeMonoWav16(tone, 44100))).json()) as { track: { id: string } };
      await upload(new Uint8Array([1, 2, 3, 4]));
      await handleDeleteTrack(new Request("http://hive.test/x", { method: "DELETE", headers: { authorization: `Bearer ${room.hostKey}` } }), ok.track.id, m, fixtures, {});

      const text = lines.join("\n");
      expect(text).toMatch(new RegExp(`room ${room.code} created \\(1 live\\)`));
      expect(text).toMatch(new RegExp(`room ${forgotten.code} ended after 2 min, 0 device\\(s\\) seen`));
      expect(text).toMatch(new RegExp(`room ${forgotten.code} restored`));
      expect(text).toMatch(/upload accepted: logged-[0-9a-f]{8} — 1 stem\(s\), 2\.0 s of audio, \d+\.\d MB, \d+ ms/);
      expect(text).toMatch(/upload refused: stem 'mix' not a WAV file/);
      expect(text).toContain(`track removed by its owner: ${ok.track.id}`);
      for (const secret of [room.hostKey, forgotten.hostKey, LIBRARY_KEY, ownerIdOf(LIBRARY_KEY)]) expect(text.includes(secret)).toBe(false);
      m.shutdown();
    } finally {
      jest.useRealTimers();
      rmSync(fixtures, { recursive: true, force: true });
    }
  });
});

describe("SCALE-NET-08: /health says how busy the server is, and nothing else", () => {
  const PORT = 23500 + Math.floor(Math.random() * 400);
  const BASE = `http://localhost:${PORT}`;
  let proc: ReturnType<typeof Bun.spawn>;
  beforeAll(async () => {
    proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env: { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", HOST_KEY_SECRET: "operations-http-secret-0123456789abcdef" }, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  });
  afterAll(() => proc.kill());

  test("counts of rooms, playing rooms, clients and connections; no room code, no ids", async () => {
    const health = async () => (await (await fetch(`${BASE}/health`)).json()) as Record<string, unknown>;
    expect(await health()).toMatchObject({ ok: true, protocolVersion: PROTOCOL_VERSION, rooms: 0, playing: 0, clients: 0, connections: 0 });

    const room = (await (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" })).json()) as { code: string; hostKey: string };
    const host = new WebSocket(`ws://localhost:${PORT}/ws`);
    const lurker = new WebSocket(`ws://localhost:${PORT}/ws`); // connects, never joins
    await Promise.all([new Promise<void>((r) => (host.onopen = () => r())), new Promise<void>((r) => (lurker.onopen = () => r()))]);
    const state = new Promise<void>((r) => (host.onmessage = (e) => void (String(e.data).includes('"ROOM_STATE"') && String(e.data).includes('"playing"') && r())));
    host.send(JSON.stringify(joinMsg("host-health-001", room.code, "host", room.hostKey)));
    const tracks = ((await (await fetch(`${BASE}/tracks`)).json()) as { tracks: Array<{ id: string }> }).tracks;
    host.send(JSON.stringify({ type: "SET_TRACK", trackId: tracks[0]!.id }));
    host.send(JSON.stringify({ type: "TRANSPORT", action: "PLAY" }));
    await state;

    const busy = await health();
    expect(busy).toMatchObject({ ok: true, rooms: 1, playing: 1, clients: 1, connections: 2 });
    expect(typeof busy.uptimeSec).toBe("number");
    const text = JSON.stringify(busy);
    expect(text.includes(room.code)).toBe(false);
    expect(text.includes("host-health-001")).toBe(false);
    expect(Object.keys(busy).sort()).toEqual(["clients", "connections", "ok", "playing", "protocolVersion", "rooms", "serverTime", "uptimeSec"]);
    host.close();
    lurker.close();
  });
});
