import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, TrackLibraryResponseSchema, type ServerMessage } from "@hive/protocol";
import { RoomManager, type Conn } from "../rooms";
import { ownerIdOf, withUrls, type LibraryScope } from "../library";
import { handleDeleteTrack, handleUploadTracks, type UploadLimits } from "../upload/route";
import { encodeMonoWav16 } from "../upload/wav";

/**
 * Owned uploads (D:\HiveMusic-audit\contracts\library-scope.md; red-team RT-02; audit SG-07 item 3).
 * The library was one global list: anyone could mint a room, upload, and have the track listed in
 * every hive and auto-rotated into every party, with no way to remove it. A hive now sees the shared
 * tracks plus the uploads of its own host's browser. The numbered tests are the contract's "what
 * must stay true" 1–7.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const KEY_A = "library-key-of-browser-A-0123456789abcdefghi";
const KEY_B = "library-key-of-browser-B-0123456789abcdefghi";
const roots: string[] = [];
const managers: RoomManager[] = [];
afterAll(() => {
  for (const m of managers) for (const code of [...(m as unknown as { rooms: Map<string, unknown> }).rooms.keys()]) m.get(code)?.destroy();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const tone = (seconds: number) => {
  const s = new Float32Array(Math.round(seconds * 44100));
  for (let i = 0; i < s.length; i++) s[i] = Math.sin(i / 30) * 0.4;
  return encodeMonoWav16(s, 44100);
};

/** Everything the server said to anyone, as text: what test 7 greps for secrets. */
const transcript: string[] = [];

async function world(scope: LibraryScope = "owner") {
  const fixtures = mkdtempSync(join(tmpdir(), "hive-library-scope-"));
  roots.push(fixtures);
  // two shared tracks, the way the built-in ones and every pre-existing upload look on disk: no owner
  for (const id of ["shared-one", "shared-two"]) {
    mkdirSync(join(fixtures, "tracks", id), { recursive: true });
    writeFileSync(join(fixtures, "tracks", id, "mix.wav"), tone(1));
    writeFileSync(join(fixtures, "tracks", id, "meta.json"), JSON.stringify({ id, title: id, durationSec: 4, stems: ["mix"], generated: false }));
  }
  const manager = new RoomManager({ fixturesDir: fixtures, libraryScope: scope, hostKeySecret: "library-scope-test-secret-0123456789abcdef" });
  managers.push(manager);
  manager.attachServer({ publish: (_t: string, data: string) => void transcript.push(data) } as unknown as Bun.Server<Conn>);
  await manager.loadLibrary();

  /** A hive hosted from a browser holding `libraryKey` (undefined: an old client that sends none). */
  function hive(libraryKey: string | undefined, hostId: string) {
    const created = manager.createRoom();
    if ("error" in created) throw new Error(created.error);
    transcript.push(JSON.stringify(created));
    const sent: ServerMessage[] = [];
    const ws = {
      data: { clientId: null, roomCode: null },
      send: (raw: string) => {
        transcript.push(raw);
        sent.push(JSON.parse(raw));
      },
      subscribe: () => {},
      close: () => {},
    } as unknown as WS;
    manager.handleMessage(ws, JSON.stringify({ type: "JOIN", clientId: hostId, roomCode: created.code, kind: "host", plays: false, hostKey: created.hostKey, libraryKey, device, protocolVersion: PROTOCOL_VERSION }));
    const room = manager.get(created.code)!;
    const say = async (res: Response) => {
      const text = await res.text();
      transcript.push(text);
      return { status: res.status, body: JSON.parse(text) as Record<string, any> };
    };
    return {
      room,
      ws,
      sent,
      code: created.code,
      hostKey: created.hostKey,
      send: (msg: unknown) => manager.handleMessage(ws, JSON.stringify(msg)),
      errors: () => sent.flatMap((m) => (m.type === "ERROR" ? [m.code] : [])),
      /** GET /tracks as index.ts answers it for this hive's key. */
      list: () => room.library().map((t) => withUrls(t, "http://hive.test", room.libraryOwner)),
      upload: async (title: string, seconds = 2, limits?: Partial<UploadLimits>) => {
        const form = new FormData();
        form.set("title", title);
        form.set("mix", new File([tone(seconds) as unknown as BlobPart], "mix.wav"));
        const req = new Request("http://hive.test/tracks", { method: "POST", body: form, headers: { authorization: `Bearer ${created.hostKey}` } });
        return say(await handleUploadTracks(req, manager, fixtures, "http://hive.test", {}, { maxUploadBytes: 64 << 20, libraryQuotaBytes: 800 << 20, ...limits }));
      },
      remove: async (id: string) => say(await handleDeleteTrack(new Request(`http://hive.test/tracks/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${created.hostKey}` } }), id, manager, fixtures, {})),
    };
  }
  return { fixtures, manager, hive };
}
const ids = (tracks: Array<{ id: string }>) => tracks.map((t) => t.id).sort();

describe("owned uploads — contract tests 1-4, 7", () => {
  test("1. A uploads; B never sees it, cannot SET_TRACK it, and B's rotation never reaches it. A sees it, marked mine", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    const up = await a.upload("Song of A");
    expect(up.status).toBe(201);
    expect(up.body.track.mine).toBe(true);
    const songA: string = up.body.track.id;

    // A's list: shared + its own, the own one marked; B's and a guest's: shared only, nothing marked
    expect(ids(a.list())).toEqual(["shared-one", "shared-two", songA].sort());
    expect(a.list().filter((t) => t.mine).map((t) => t.id)).toEqual([songA]);
    expect(ids(b.list())).toEqual(["shared-one", "shared-two"]);
    expect(b.list().some((t) => t.mine)).toBe(false);

    // B cannot select it: it does not exist as far as B can tell
    b.send({ type: "SET_TRACK", trackId: songA });
    b.send({ type: "SET_TRACK", trackId: "no-such-track-at-all" });
    expect(b.errors()).toEqual(["NO_TRACK", "NO_TRACK"]);
    const noTrack = b.sent.filter((m) => m.type === "ERROR").map((m) => (m.type === "ERROR" ? m.message.replace(/track \S+/, "track X") : ""));
    expect(noTrack[0]).toBe(noTrack[1]); // same answer, word for word, as for an id that does not exist
    expect(b.room.room.track).toBeNull();

    // B's rotation: shared-one → shared-two → shared-one …, never A's song. A's reaches it.
    jest.useFakeTimers();
    try {
      b.send({ type: "SET_TRACK", trackId: "shared-one" });
      b.send({ type: "TRANSPORT", action: "PLAY" });
      a.send({ type: "SET_TRACK", trackId: "shared-one" });
      a.send({ type: "TRANSPORT", action: "PLAY" });
      const seenB = new Set<string>();
      const seenA = new Set<string>();
      for (let i = 0; i < 80; i++) {
        jest.advanceTimersByTime(1000);
        seenB.add(b.room.room.track!.id).add(b.room.room.nextTrack?.id ?? "-");
        seenA.add(a.room.room.track!.id).add(a.room.room.nextTrack?.id ?? "-");
      }
      expect([...seenB].sort()).toEqual(["shared-one", "shared-two"]);
      expect(seenA.has(songA)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("2. A's second hive (a new room, the same browser) sees A's uploads; a room whose host sent no libraryKey sees shared only and cannot upload", async () => {
    const w = await world();
    const first = w.hive(KEY_A, "host-A-000001");
    const songA: string = (await first.upload("Kept")).body.track.id;
    first.room.destroy();

    const second = w.hive(KEY_A, "host-A-000002");
    expect(second.code).not.toBe(first.code);
    expect(ids(second.list())).toContain(songA);
    second.send({ type: "SET_TRACK", trackId: songA });
    expect(second.room.room.track?.id).toBe(songA);

    const old = w.hive(undefined, "host-old-00001"); // an older web bundle
    expect(ids(old.list())).toEqual(["shared-one", "shared-two"]);
    const refused = await old.upload("From an old client");
    expect(refused).toEqual({ status: 400, body: { error: "no_library", message: "Reload this page, then try again." } });
    // …and when its page reloads into the new bundle, its JOIN gives the room an owner
    const ws2 = { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
    w.manager.handleMessage(ws2, JSON.stringify({ type: "JOIN", clientId: "host-old-00002", roomCode: old.code, kind: "host", plays: false, hostKey: old.hostKey, libraryKey: KEY_B, device, protocolVersion: PROTOCOL_VERSION }));
    expect((await old.upload("After reload")).status).toBe(201);
  });

  test("a libraryKey only counts on a JOIN that proved it is the host", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const songA: string = (await a.upload("Private")).body.track.id;
    const b = w.hive(KEY_B, "host-B-000001");
    // a guest of B's hive who somehow knows A's libraryKey, claiming host without B's hostKey
    const ws = { data: { clientId: null, roomCode: null }, send: () => {}, subscribe: () => {}, close: () => {} } as unknown as WS;
    w.manager.handleMessage(ws, JSON.stringify({ type: "JOIN", clientId: "guest-000001", roomCode: b.code, kind: "host", plays: false, hostKey: "wrong", libraryKey: KEY_A, device, protocolVersion: PROTOCOL_VERSION }));
    w.manager.handleMessage(ws, JSON.stringify({ type: "JOIN", clientId: "guest-000002", roomCode: b.code, kind: "player", plays: true, libraryKey: KEY_A, device, protocolVersion: PROTOCOL_VERSION }));
    expect(b.room.libraryOwner).toBe(ownerIdOf(KEY_B));
    expect(ids(b.list())).not.toContain(songA);
  });

  test("3. tracks with no owner are visible to everyone and cannot be deleted by anyone", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    for (const h of [a, b]) {
      expect(ids(h.list())).toEqual(expect.arrayContaining(["shared-one", "shared-two"]));
      expect(await h.remove("shared-one")).toEqual({ status: 403, body: { error: "not_owner" } });
    }
    expect((await w.manager.getLibrary()).map((t) => t.id)).toContain("shared-one");
    // no key at all, or a key that is not a live room's
    const anon = await handleDeleteTrack(new Request("http://hive.test/tracks/shared-one", { method: "DELETE" }), "shared-one", w.manager, w.fixtures, {});
    expect(anon.status).toBe(403);
    const stale = await handleDeleteTrack(new Request("http://hive.test/tracks/shared-one", { method: "DELETE", headers: { authorization: "Bearer not-a-live-key" } }), "shared-one", w.manager, w.fixtures, {});
    expect(stale.status).toBe(403);
  });

  test("4. A cannot delete B's track (it does not exist for A); the owner can, unless it is playing somewhere; nextTrack follows", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    const songB: string = (await b.upload("Song of B")).body.track.id;

    expect(await a.remove(songB)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await a.remove("never-existed")).toEqual({ status: 404, body: { error: "not_found" } }); // indistinguishable
    expect(w.manager.getLibrary().some((t) => t.id === songB)).toBe(true);

    b.send({ type: "SET_TRACK", trackId: songB });
    expect(await b.remove(songB)).toEqual({ status: 409, body: { error: "in_use", message: "That song is playing — pick another first." } });
    b.send({ type: "SET_TRACK", trackId: "shared-two" });
    expect(b.room.room.nextTrack?.id).toBe(songB); // the rotation would go shared-two → B's song (title order)
    expect(await b.remove(songB)).toEqual({ status: 200, body: { ok: true } });
    expect(w.manager.getLibrary().some((t) => t.id === songB)).toBe(false);
    expect(Bun.file(join(w.fixtures, "tracks", songB, "meta.json")).size).toBe(0); // gone from disk
    expect(b.room.room.nextTrack?.id).toBe("shared-one"); // and the room's promise about what comes next is current
    expect(await b.remove(songB)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  test("quotas: per owner by count and by bytes, and the volume keeps 100 MB free; shared tracks do not count", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    expect((await a.upload("one", 2, { ownerMaxTracks: 2 })).status).toBe(201);
    expect((await a.upload("two", 2, { ownerMaxTracks: 2 })).status).toBe(201);
    expect(await a.upload("three", 2, { ownerMaxTracks: 2 })).toMatchObject({ status: 413, body: { error: "too_many_tracks" } });
    expect((await b.upload("b one", 2, { ownerMaxTracks: 2 })).status).toBe(201); // B has its own allowance

    // ~176 KB per 2 s song: A holds two (≈353 KB); a 400 KB allowance has no room for a third
    expect(await a.upload("too big", 2, { ownerMaxBytes: 400_000 })).toMatchObject({ status: 413, body: { error: "owner_quota" } });
    expect((await a.upload("fits", 2, { ownerMaxBytes: 600_000 })).status).toBe(201);

    // the volume: an upload that would leave less than the reserve free is refused, whoever asks
    const nearlyFull = { volumeFreeBytes: async () => 100 * 1024 * 1024 + 100_000 }; // 100 KB above the 100 MB reserve
    expect(await b.upload("no room", 2, nearlyFull)).toMatchObject({ status: 507, body: { error: "library_full" } });
    expect((await b.upload("room", 2, { volumeFreeBytes: async () => 101 * 1024 * 1024 })).status).toBe(201);
    for (const r of [await a.upload("x", 2, { ownerMaxTracks: 0 }), await b.upload("y", 2, nearlyFull)]) expect(typeof r.body.message).toBe("string"); // a sentence the page can show
  });

  test("7. neither the libraryKey nor an owner id ever appears in anything the server sends, publishes or writes to a client", async () => {
    const w = await world();
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    const songA: string = (await a.upload("Secret keeper")).body.track.id;
    a.send({ type: "SET_TRACK", trackId: songA });
    a.send({ type: "TRANSPORT", action: "PLAY" });
    b.send({ type: "SET_TRACK", trackId: songA }); // an error path
    await b.remove(songA); // another
    await b.upload("mine", 2, { ownerMaxTracks: 0 }); // a refusal
    (a.room as unknown as { publishHealth(): void }).publishHealth();
    const listing = JSON.stringify({ a: a.list(), b: b.list() });
    expect(TrackLibraryResponseSchema.safeParse({ tracks: a.list() }).success).toBe(true);

    const everything = [...transcript, listing, JSON.stringify(a.room.room), JSON.stringify(b.room.room)].join("\n");
    for (const secret of [KEY_A, KEY_B, ownerIdOf(KEY_A), ownerIdOf(KEY_B)]) expect(everything.includes(secret)).toBe(false);
    expect(everything.includes('"owner"')).toBe(false);
    expect(everything.includes("libraryKey")).toBe(false);
    // the owner id exists in exactly one place: the track's meta.json on the server's disk
    expect(JSON.parse(readFileSync(join(w.fixtures, "tracks", songA, "meta.json"), "utf8")).owner).toBe(ownerIdOf(KEY_A));
  });

  test("meta.json's owner is validated like every other field: a malformed one hides the track rather than sharing it", async () => {
    const w = await world();
    for (const [dir, owner] of [["bad-owner-1", "not-hex"], ["bad-owner-2", 12345], ["bad-owner-3", "ABCDEF0123456789ABCDEF0123456789"], ["bad-owner-4", ""]] as const) {
      mkdirSync(join(w.fixtures, "tracks", dir), { recursive: true });
      writeFileSync(join(w.fixtures, "tracks", dir, "meta.json"), JSON.stringify({ id: dir, title: dir, durationSec: 4, stems: ["mix"], owner }));
    }
    mkdirSync(join(w.fixtures, "tracks", "null-owner"), { recursive: true });
    writeFileSync(join(w.fixtures, "tracks", "null-owner", "meta.json"), JSON.stringify({ id: "null-owner", title: "n", durationSec: 4, stems: ["mix"], owner: null }));
    await w.manager.loadLibrary();
    expect(ids(w.manager.getLibrary())).toEqual(["null-owner", "shared-one", "shared-two"]); // null = no owner = shared
  });
});

describe("owned uploads — contract test 5: LIBRARY_SCOPE=global is yesterday's behaviour", () => {
  test("one list for everyone, uploads need no libraryKey, rotation runs through all of it; ownership still decides who may delete", async () => {
    const w = await world("global");
    const a = w.hive(KEY_A, "host-A-000001");
    const b = w.hive(KEY_B, "host-B-000001");
    const old = w.hive(undefined, "host-old-00001");
    const songA: string = (await a.upload("Song of A")).body.track.id;
    const unowned = await old.upload("From an old client");
    expect(unowned.status).toBe(201);
    expect(unowned.body.track.mine).toBeUndefined();

    for (const h of [a, b, old]) expect(ids(h.list())).toEqual(["shared-one", "shared-two", songA, unowned.body.track.id].sort());
    b.send({ type: "SET_TRACK", trackId: songA });
    expect(b.room.room.track?.id).toBe(songA);
    b.send({ type: "SET_TRACK", trackId: "shared-one" });
    expect(await b.remove(songA)).toEqual({ status: 403, body: { error: "not_owner" } });
    expect(await a.remove(unowned.body.track.id)).toEqual({ status: 403, body: { error: "not_owner" } });
    expect((await a.remove(songA)).status).toBe(200);
  });
});

describe("owned uploads over HTTP — contract test 6 and the REST surface", () => {
  const PORT = 21500 + Math.floor(Math.random() * 400);
  const BASE = `http://localhost:${PORT}`;
  const fixtures = mkdtempSync(join(tmpdir(), "hive-library-http-"));
  roots.push(fixtures);
  let proc: ReturnType<typeof Bun.spawn>;
  beforeAll(async () => {
    proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env: { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", FIXTURES_DIR: fixtures, LIBRARY_SCOPE: "", HOST_KEY_SECRET: "library-http-test-secret-0123456789abcdef" }, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  });
  afterAll(() => proc.kill());

  async function hostOf(libraryKey: string, clientId: string) {
    const created = (await (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" })).json()) as { code: string; hostKey: string };
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const welcomed = new Promise<void>((r) => (ws.onmessage = (e) => void (String(e.data).includes('"WELCOME"') && r())));
    ws.send(JSON.stringify({ type: "JOIN", clientId, roomCode: created.code, kind: "host", plays: false, hostKey: created.hostKey, libraryKey, device, protocolVersion: PROTOCOL_VERSION }));
    await welcomed;
    const auth = { authorization: `Bearer ${created.hostKey}` };
    return { ...created, ws, auth, list: async (headers: Record<string, string> = auth) => ((await (await fetch(`${BASE}/tracks`, { headers })).json()) as { tracks: Array<{ id: string; mine?: boolean; urls: Record<string, string>; owner?: unknown }> }).tracks };
  }

  test("6. a guest with no key can fetch the audio of an owned track; GET /tracks without a key lists shared tracks only; DELETE works with CORS", async () => {
    const a = await hostOf(KEY_A, "host-http-A-001");
    const b = await hostOf(KEY_B, "host-http-B-001");
    const form = new FormData();
    form.set("title", "Owned over HTTP");
    form.set("mix", new File([tone(2) as unknown as BlobPart], "mix.wav"));
    const up = await fetch(`${BASE}/tracks`, { method: "POST", body: form, headers: a.auth });
    expect(up.status).toBe(201);
    const track = ((await up.json()) as { track: { id: string; mine?: boolean; urls: Record<string, string> } }).track;
    expect(track.mine).toBe(true);

    const mine = await a.list();
    expect(mine.find((t) => t.id === track.id)?.mine).toBe(true);
    expect(mine.every((t) => !("owner" in t))).toBe(true);
    expect((await b.list()).some((t) => t.id === track.id)).toBe(false);
    expect((await a.list({})).some((t) => t.id === track.id)).toBe(false); // no key
    expect((await a.list({ authorization: "Bearer made-up" })).some((t) => t.id === track.id)).toBe(false); // unknown key
    expect((await fetch(`${BASE}/tracks?q=owned`, { headers: a.auth }).then((r) => r.json() as Promise<{ tracks: unknown[] }>)).tracks.length).toBe(1); // ?q= still filters

    // a guest: no key, just the URL the host's ROOM_STATE / track list points at
    const audio = await fetch(track.urls.mix!);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect((await audio.arrayBuffer()).byteLength).toBe(tone(2).byteLength);

    // the browser's preflight for DELETE, then the delete itself — B is refused, A succeeds
    const preflight = await fetch(`${BASE}/tracks/${track.id}`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect((await fetch(`${BASE}/tracks/${track.id}`, { method: "DELETE", headers: b.auth })).status).toBe(404);
    expect((await fetch(`${BASE}/tracks/${track.id}`, { method: "DELETE" })).status).toBe(403);
    const gone = await fetch(`${BASE}/tracks/${track.id}`, { method: "DELETE", headers: a.auth });
    expect(gone.status).toBe(200);
    expect((await fetch(track.urls.mix!)).status).toBe(404);
    expect((await a.list()).some((t) => t.id === track.id)).toBe(false);
    a.ws.close();
    b.ws.close();
  });
});
