/**
 * @hive/protocol mock server — the frontend's stand-in for apps/server until integration.
 * Same schemas, same planner, same routes. Drives itself from a scenario file:
 *   bun run mock --scenario apps/web/mocks/scenarios/party-12.json   (or MOCK_SCENARIO=...)
 * Ports: PORT (default 8080). WebSocket at /ws. REST: /health /rooms /rooms/:code /tracks /audio/:id/:stem.wav /rooms/:code/vibe
 *
 * Parity with apps/server is the point of this file — the whole e2e suite runs against it. What is
 * deliberately different, and only this: one room (the scenario's), a fixed `hostKey`, seeded `mock-*`
 * players with synthetic health and fake calibration results, a fixed rules-only `/vibe` plan, no
 * `POST /tracks` upload (501), no idle TTL, no ping timeout, a fixed 2 Hz publish tick instead of the
 * server's leading-edge coalescer, and a short audio cache lifetime. Everything else must behave like
 * `apps/server/src/rooms.ts`; `scripts/parity-probe.ts` runs the same probes against both.
 *
 * ROOM_STATE in particular is sent **per recipient**, as the server sends it (`sendState` there,
 * `playerRoomView` here): a player is told the room-level state and its own record, nothing about
 * anyone else. Only *what* is sent is mirrored, not how often — the server also skips a recipient whose
 * message would be byte-identical to its last one, holds back a socket that has not drained, and
 * repeats the state on a heartbeat while playing; the mock sends every recipient its view on every
 * publish.
 */
import { z } from "zod";
import {
  BROWSER_FAMILIES, CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, DISCONNECT_RETENTION_MS, HEALTH_HZ, LEAD_MS, MODES,
  PROTOCOL_VERSION, ROOM_STATE_MAX_HZ, STARTER_LATENCY_TABLE_MS, STEMS, TRACK_ADVANCE_LEAD_MS,
} from "./constants";
import { DEFAULT_CLICK_SPEC, parseClientMessage, type ClientMessage, type ServerMessage } from "./messages";
import { ModeParamsSchema } from "./mode";
import { withAssignments } from "./planner";
import { IDLE_CALIBRATION, StemRoleSchema, trackTimeSec, type ClientRecord, type RoomState, type TrackInfo } from "./room";
import { VibeRequestSchema, type TrackLibraryEntry } from "./rest";
import { ScenePlanCoreSchema, type Scene, type ScenePlan } from "./scene";
import { currentScene, loopRestartZero, nextInRotation, nextScene } from "./timeline";
import type { HealthLevel } from "./constants";
import type { AudioState } from "./health";

// ---- scenario ---------------------------------------------------------------
export const ScenarioSchema = z.object({
  roomCode: z.string().min(3).max(8).default("BZQ7"),
  trackId: z.string().default("synthetic-60s"),
  mode: z.object({ kind: z.enum(MODES), params: ModeParamsSchema.default({}) }).default({ kind: "UNISON", params: {} }),
  transport: z.enum(["stopped", "playing", "paused"]).default("stopped"),
  hostPlays: z.boolean().default(false),
  players: z
    .array(
      z.object({
        name: z.string(),
        browserFamily: z.enum(BROWSER_FAMILIES).default("other"),
        position: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).nullable().default(null),
        health: z.enum(["good", "warn", "bad", "unknown"]).default("good"),
        pinnedRole: StemRoleSchema.nullable().default(null),
      }),
    )
    .default([]),
  calibration: z.object({ state: z.enum(["running", "done"]), doneCount: z.number().int().min(0).default(0) }).nullable().default(null),
  scenePlan: z.object({ prompt: z.string(), scenes: ScenePlanCoreSchema.shape.scenes }).nullable().default(null),
  /**
   * `restartAfterSec`: drop every socket that many seconds in. `wipe: true` also forgets the show, as
   * a real restart does: apps/server keeps rooms in memory, and the host's key re-creates the room
   * under the same code but empty (see `simulateRestart`).
   */
  chaos: z.object({ restartAfterSec: z.number().positive(), wipe: z.boolean().default(false) }).nullable().default(null),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

/**
 * The ROOM_STATE a **player** is sent: the room-level state, a roster of exactly one (itself), no host
 * ids, and the calibration block cut down to what its own tuning screen shows. The same projection as
 * `playerView` in apps/server/src/rooms.ts (`sendState`), field for field — keep the two in step.
 *
 * This is the reason the mock sends state per recipient at all. While it published the whole room to
 * everyone, guest code that looked another client up in the roster (the host, to decide "the host has
 * gone") passed every browser test and could never work in production.
 */
export function playerRoomView(room: RoomState, id: string): RoomState {
  const { clients, calibration, hostClientIds: _hosts, ...level } = room;
  const inFlight = calibration.state === "countdown" || calibration.state === "running";
  const mine = calibration.results[id];
  const isReference = calibration.referenceClientId === id;
  return {
    ...level,
    hostClientIds: [],
    calibration: {
      state: calibration.state,
      referenceClientId: isReference ? id : null,
      startServerTime: calibration.startServerTime,
      // The slots, with every id but its own blanked: enough for "click 7 of 30, yours is the 12th".
      order: inFlight ? calibration.order.map((o) => (o === id ? o : "")) : [],
      results: mine ? { [id]: mine } : {},
    },
    clients: { [id]: clients[id]! },
  };
}

/** Upper bound on one client→server frame (proposed for apps/server too: PROTO-03). */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/** See startCalibration. True since the stub engine announces AUDIO_READY like the real one (PROTO-15). */
const REQUIRE_AUDIO_READY_FOR_CALIBRATION = true;

const now = () => performance.timeOrigin + performance.now();
const HEALTH_SYNC_ERR: Record<HealthLevel, number | null> = { good: 3, warn: 12, bad: 38, unknown: null };

// ---- track library (fixtures) ----------------------------------------------
type LibraryEntry = Omit<TrackLibraryEntry, "urls">;

/** Mirrors apps/server/src/library.ts: same fields (incl. `beatOffsetSec`), same order (`order`, then title). */
async function loadLibrary(fixturesDir: string): Promise<LibraryEntry[]> {
  const out: Array<LibraryEntry & { _order: number }> = [];
  const glob = new Bun.Glob("*/meta.json");
  try {
    for await (const rel of glob.scan({ cwd: `${fixturesDir}/tracks` })) {
      const meta = await Bun.file(`${fixturesDir}/tracks/${rel}`).json();
      out.push({
        id: meta.id, title: meta.title, durationSec: meta.durationSec, stems: meta.stems, bpm: meta.bpm, beatOffsetSec: meta.beatOffsetSec,
        energy: meta.energy, clickTimesSec: meta.clickTimesSec, dropSec: meta.dropSec, generated: meta.generated,
        _order: typeof meta.order === "number" ? meta.order : Number.MAX_SAFE_INTEGER,
      });
    }
  } catch {
    /* no fixtures dir: fall through */
  }
  out.sort((a, b) => a._order - b._order || a.title.localeCompare(b.title));
  if (out.length === 0) return [{ id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: [...STEMS], bpm: 120, generated: true }];
  return out.map(({ _order, ...entry }) => entry);
}

/** URLs are built per request from the request's own origin, so localhost, 127.0.0.1 and a LAN IP all work. */
function withUrls(entry: LibraryEntry, origin: string): TrackLibraryEntry {
  const urls: Record<string, string> = {};
  for (const stem of entry.stems) urls[stem] = `${origin}/audio/${entry.id}/${stem}.wav`;
  return { ...entry, urls };
}

// ---- server -----------------------------------------------------------------
export interface MockServerOptions {
  port?: number;
  scenario?: ScenarioInput;
  fixturesDir?: string;
  quiet?: boolean;
}

export function startMockServer(opts: MockServerOptions = {}) {
  const scenario = ScenarioSchema.parse(opts.scenario ?? {});
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const fixturesDir = opts.fixturesDir ?? `${import.meta.dir}/../../../fixtures`;
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log("[mock]", ...a);

  let library: LibraryEntry[] = [];
  const hostKey = "mock-host-key";
  let room: RoomState = {
    code: scenario.roomCode,
    protocolVersion: PROTOCOL_VERSION,
    createdAtServerTime: now(),
    hostClientIds: [],
    track: null,
    transport: { state: "stopped" },
    mode: scenario.mode,
    scenePlan: scenario.scenePlan ? { ...scenario.scenePlan, source: "rules", createdAtServerTime: now() } : null,
    calibration: IDLE_CALIBRATION,
    clients: {},
  };
  let joinCounter = 0;
  const health = new Map<string, { rttMs: number | null; syncErrMs: number | null; outputLatencyMs: number | null; audioState: AudioState; lastSeenServerTime: number }>();
  const sockets = new Map<string, Bun.ServerWebSocket<{ clientId: string | null }>>();
  /**
   * Every open socket that JOINed as a client — the newest per id (`sockets`) and any older one still
   * open (the server's `standby`: one browser's tabs share a client id). All of them are sent state.
   */
  const members = new Set<Bun.ServerWebSocket<{ clientId: string | null }>>();
  let dirty = false;
  let calibrationTimers: ReturnType<typeof setTimeout>[] = [];
  let sceneTimer: ReturnType<typeof setTimeout> | null = null;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;
  const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function seedPlayers() {
    scenario.players.forEach((p, i) => {
      const id = `mock-${String(i + 1).padStart(2, "0")}-${p.name.toLowerCase()}`;
      room.clients[id] = {
        id, kind: "player", plays: true, name: p.name,
        device: { userAgent: "mock", platform: "mock", browserFamily: p.browserFamily },
        joinIndex: joinCounter++, joinedAtServerTime: now(),
        position: p.position ? { x: p.position[0], y: p.position[1] } : null,
        pinnedRole: p.pinnedRole, nudgeMs: 0,
        tableLatencyMs: STARTER_LATENCY_TABLE_MS[p.browserFamily], calibratedOffsetMs: null,
        assignment: null, connected: p.health !== "bad", audioReadyTrackId: null,
      };
      health.set(id, { rttMs: p.health === "unknown" ? null : 24, syncErrMs: HEALTH_SYNC_ERR[p.health], outputLatencyMs: null, audioState: "ready", lastSeenServerTime: now() });
    });
  }

  function setTrack(t: LibraryEntry | undefined) {
    if (!t) return;
    const info: TrackInfo = { id: t.id, title: t.title, durationSec: t.durationSec, stems: t.stems, bpm: t.bpm, beatOffsetSec: t.beatOffsetSec };
    room.track = info;
    for (const c of Object.values(room.clients)) if (c.id.startsWith("mock-")) c.audioReadyTrackId = t.id;
  }

  function replan(applyAt: number | null = null) {
    room = withAssignments(room, applyAt);
    dirty = true;
  }

  function send(ws: Bun.ServerWebSocket<{ clientId: string | null }>, msg: ServerMessage) {
    ws.send(JSON.stringify(msg));
  }

  // ---- scene timer and loop timer: the same rules as apps/server (timeline.ts holds the math) ---------
  function cancelSceneTimer() {
    if (sceneTimer) clearTimeout(sceneTimer);
    sceneTimer = null;
  }
  function rearmSceneTimer() {
    cancelSceneTimer();
    const armed = nextScene(room.scenePlan, room.transport, now());
    if (!armed) return;
    sceneTimer = setTimeout(() => {
      room.mode = { kind: armed.scene.mode, params: armed.scene.params };
      replan(armed.boundaryServerTime);
      flush();
      rearmSceneTimer();
    }, Math.max(0, armed.fireAtServerTime - now()));
  }
  /** PLAY/SEEK or a freshly accepted plan: the scene at or before the position is the mode, immediately. */
  function syncModeToScenePlan() {
    if (!room.scenePlan || room.transport.state !== "playing") return;
    const cur = currentScene(room.scenePlan, room.transport, now());
    if (cur) {
      room.mode = { kind: cur.mode, params: cur.params };
      replan();
    }
  }
  function cancelLoopTimer() {
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
  }
  /** End of track: advance to the next song in the rotation, or restart the only one seamlessly. */
  function rearmLoopTimer() {
    cancelLoopTimer();
    if (room.transport.state !== "playing" || !room.track) return;
    const endServerTime = room.transport.serverTimeAtTrackZero + room.track.durationSec * 1000;
    loopTimer = setTimeout(() => {
      loopTimer = null;
      if (room.transport.state !== "playing" || !room.track) return;
      const next = nextInRotation(library, room.track.id);
      if (next) {
        setTrack(next);
        room.scenePlan = null; // the vibe plan was authored for the song that just ended
        room.transport = { state: "playing", serverTimeAtTrackZero: Math.max(now(), endServerTime) + TRACK_ADVANCE_LEAD_MS };
        replan();
      } else {
        room.transport = { state: "playing", serverTimeAtTrackZero: loopRestartZero(endServerTime, now()) };
        dirty = true;
      }
      flush();
      syncModeToScenePlan();
      rearmSceneTimer();
      rearmLoopTimer();
    }, Math.max(0, endServerTime - LEAD_MS - now()));
  }

  const server = Bun.serve<{ clientId: string | null }>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const cors = { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS" }; // as apps/server: the host key travels as a Bearer header
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname === "/ws") {
        return srv.upgrade(req, { data: { clientId: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return json({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: now(), mock: true });
      if (url.pathname === "/rooms" && req.method === "POST") {
        // One room only, but the same answers as the real server (apps/server, audit SG-01):
        //   {}                      -> "Host a hive": the room and its key
        //   {code} of another room  -> 400 unknown room code
        //   {code} of this room     -> the key is echoed only to a caller that already presents it;
        //                              anyone else gets 403 NOT_HOST and never a key
        const body = ((await req.json().catch(() => ({}))) ?? {}) as { code?: unknown; hostKey?: unknown };
        const asked = typeof body.code === "string" && body.code ? body.code.toUpperCase() : null;
        if (asked && asked !== room.code) return json({ error: "unknown room code" }, 400);
        if (asked && body.hostKey !== hostKey) return json({ error: "NOT_HOST" }, 403);
        return json({ code: room.code, hostKey, joinUrl: `${process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000"}/j/${room.code}` });
      }
      const roomMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)$/);
      if (roomMatch && req.method === "GET") {
        const exists = roomMatch[1]!.toUpperCase() === room.code;
        return json({ code: roomMatch[1]!.toUpperCase(), exists, players: exists ? Object.values(room.clients).filter((c) => c.kind === "player").length : 0 }, exists ? 200 : 404);
      }
      const vibeMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)\/vibe$/);
      if (vibeMatch && req.method === "POST") {
        if (vibeMatch[1]!.toUpperCase() !== room.code) return json({ error: "no such room" }, 404);
        const parsed = VibeRequestSchema.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return json({ error: "bad prompt" }, 400);
        const dur = room.track?.durationSec ?? 60;
        const fixed: Scene[] = [
          { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
          { atTrackSec: Math.round(dur * 0.5), mode: "ORCHESTRA", params: {}, note: "build" },
          { atTrackSec: Math.round(dur * 0.75), mode: "WAVE", params: { axis: "x", spanMs: 240 }, note: "drop" },
        ];
        // strictly ascending and inside the track, whatever its length (a 1 s track used to yield 0, 1, 1)
        const scenes = fixed.filter((sc, i) => i === 0 || (sc.atTrackSec < dur && sc.atTrackSec > fixed[i - 1]!.atTrackSec));
        const scenePlan: ScenePlan = { prompt: parsed.data.prompt, source: "rules", createdAtServerTime: now(), scenes };
        room.scenePlan = scenePlan;
        dirty = true;
        syncModeToScenePlan();
        rearmSceneTimer();
        flush();
        return json({ scenePlan });
      }
      if (url.pathname === "/tracks" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return json({ tracks: library.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.includes(q)).map((t) => withUrls(t, url.origin)) });
      }
      if (url.pathname === "/tracks" && req.method === "POST") return json({ error: "uploads are not available on the mock server" }, 501);
      // Owned uploads (contracts/library-scope.md): every fixture track is shared — nothing here is
      // anyone's — so no entry is ever `mine` and nothing can be removed. `JOIN.libraryKey` is accepted
      // by the schema and ignored.
      const removal = url.pathname.match(/^\/tracks\/([A-Za-z0-9_-]+)$/);
      if (removal && req.method === "DELETE") {
        return library.some((t) => t.id === removal[1]) ? json({ error: "not_owner" }, 403) : json({ error: "not_found" }, 404);
      }
      const audio = url.pathname.match(/^\/audio\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.wav$/);
      if (audio) {
        const f = Bun.file(`${fixturesDir}/tracks/${audio[1]}/${audio[2]}.wav`);
        if (await f.exists()) return new Response(f, { headers: { ...cors, "Content-Type": "audio/wav", "Cache-Control": "public, max-age=3600" } });
        return json({ error: "not found; run `bun run fixtures`" }, 404);
      }
      return json({ error: "not found" }, 404);
    },
    websocket: {
      // No legitimate client frame is near this (the largest is a 64-phone CALIBRATION_REPORT, ~6 KB);
      // Bun's default is 16 MB, which is 16 MB of JSON.parse per hostile frame.
      maxPayloadLength: MAX_CLIENT_FRAME_BYTES,
      open() {
        /* subscribed to the room once it JOINs: a socket that has not joined is told nothing */
      },
      message(ws, raw) {
        const msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        if (!msg) return send(ws, { type: "ERROR", code: "BAD_MESSAGE", message: "message failed schema validation" });
        handle(ws, msg);
      },
      close(ws) {
        observers.delete(ws);
        members.delete(ws); // before the publish below: a closed socket is not a recipient
        const id = ws.data.clientId;
        if (!id || !room.clients[id]) return;
        /*
         * Only the socket we currently hold for this client may demote it. A phone can briefly have two
         * sockets — a reconnect racing a manual retry, or a "Tap to resume" during the backoff — and the
         * orphan's close arrives *after* the new socket has already JOINed. Keyed only by clientId, that
         * close marked the client disconnected and deleted the LIVE socket's registration: the phone
         * stayed connected and kept playing, while the server stopped sending it anything targeted
         * (SCHEDULED_ACTION, CALIBRATION_PLAN) and showed it as offline in the Hive Map for the rest of
         * the set. Nothing looked broken from either end, which is why it needs a test rather than a
         * comment.
         */
        if (sockets.get(id) !== ws) return;
        room.clients[id]!.connected = false;
        sockets.delete(id);
        // Re-plan, not just re-publish: the planner covers for a speaker that is not there (ORCHESTRA
        // folds its stem onto a partner, STEREO and STROBE close the gap), so who is connected is an input.
        replan();
        // The record keeps its slot for the retention window, then goes — as on the real server.
        clearDisconnectTimer(id);
        disconnectTimers.set(id, setTimeout(() => {
          disconnectTimers.delete(id);
          delete room.clients[id];
          room.hostClientIds = room.hostClientIds.filter((h) => h !== id);
          replan();
        }, DISCONNECT_RETENTION_MS));
      },
    },
  });

  function clearDisconnectTimer(id: string) {
    const t = disconnectTimers.get(id);
    if (t) clearTimeout(t);
    disconnectTimers.delete(id);
  }

  /** Read-only sockets with no client identity: a keyless JOIN that named a host record (see JOIN). */
  const observers = new Set<Bun.ServerWebSocket<{ clientId: string | null }>>();
  const received: Partial<Record<ClientMessage["type"], number>> = {};

  function handle(ws: Bun.ServerWebSocket<{ clientId: string | null }>, msg: ClientMessage) {
    // Per-type arrival counts. Cheap, and the only way a test can assert a *negative* — that a reconnect
    // storm did not produce two JOINs or two AUDIO_READYs per phone.
    received[msg.type] = (received[msg.type] ?? 0) + 1;
    const me = ws.data.clientId ? room.clients[ws.data.clientId] : undefined;
    const isHost = !!me && room.hostClientIds.includes(me.id);
    const hostOnly = () => {
      if (!isHost) send(ws, { type: "ERROR", code: "NOT_HOST", message: "host only" });
      return isHost;
    };
    switch (msg.type) {
      case "JOIN": {
        if (msg.roomCode.toUpperCase() !== room.code) return send(ws, { type: "ERROR", code: "NO_ROOM", message: `room ${msg.roomCode} does not exist` });
        const existing = room.clients[msg.clientId];
        // The user agent (up to 512 chars) is dead weight on every ROOM_STATE; never store it (as the server).
        const device = { ...msg.device, userAgent: "" };
        /*
         * Host is granted by exactly one thing: this JOIN carries the room's hostKey — on the first join
         * and on every reconnect (apps/server, audit SG-02). It used to be granted as well when the record
         * was already a host, or when the room had no host yet; but every client id is in every ROOM_STATE
         * and "no host yet" is true before the host's first JOIN, so either clause let any guest take the
         * room without the key.
         *
         * A keyless JOIN that names an existing host record gets a read-only observer seat instead: it
         * watches, it has no client identity, it cannot displace the host's socket or change the record.
         */
        const wantsHost = msg.kind === "host" && msg.hostKey === hostKey;
        if (existing?.kind === "host" && !wantsHost) {
          observers.add(ws);
          ws.subscribe(room.code);
          send(ws, { type: "WELCOME", clientId: msg.clientId, roomCode: room.code, serverTime: now(), protocolVersion: PROTOCOL_VERSION, isHost: false });
          send(ws, { type: "ROOM_STATE", room }); // an observer watches the whole room, like a host or a viewer
          return;
        }
        /*
         * A viewer (v4, R-13) needs no credential and must not become a speaker. `plays` is forced false
         * rather than trusted: the field is what a client *asked* for, and a display that inflated the
         * player count would consume a stem in ORCHESTRA's `joinIndex % roles.length` rotation — the room
         * would lose a whole instrument to a laptop on a table.
         */
        const isViewer = !wantsHost && msg.kind === "viewer";
        const rec: ClientRecord = existing
          ? {
              ...existing,
              connected: true,
              name: msg.name ?? existing.name,
              device,
              /*
               * R-16: re-derive `kind` and `plays` on EVERY join, not only when the record is new. The old
               * code spread `...existing` and never consulted `wantsHost`, so a client demoted once — a
               * host whose stored key had gone stale — could never come back, no matter how many times it
               * re-JOINed with the room's real key: `existing.kind` was already "player" and nothing read
               * the key again. `clientId` is persisted per room independently of `hostKey`, so that is the
               * *normal* recovery path, not an edge case.
               *
               * The two viewer branches are the engine's addition (apps/server has no viewer yet — R-13
               * asks for them there too). A record that asks to be a viewer becomes one even if it was a
               * player: `/screen` opened in a browser that already joined as a player reuses the same
               * persisted `clientId`, and inheriting "player" is exactly the stem-stealing bug R-13 was
               * about. The reverse — a viewer id that later joins as a player — must get `plays: true`
               * back, or that phone would be silently silent for the rest of the set.
               */
              kind: wantsHost ? "host" : isViewer ? "viewer" : existing.kind === "viewer" ? "player" : existing.kind,
              plays: wantsHost
                ? msg.plays
                : isViewer
                  ? false
                  : existing.kind === "viewer"
                    ? true
                    : existing.plays,
            }
          : {
              id: msg.clientId,
              kind: wantsHost ? "host" : isViewer ? "viewer" : "player",
              plays: wantsHost ? msg.plays : isViewer ? false : true,
              name: msg.name ?? `Phone ${joinCounter + 1}`, device,
              joinIndex: joinCounter++, joinedAtServerTime: now(), position: null, pinnedRole: null, nudgeMs: 0,
              tableLatencyMs: STARTER_LATENCY_TABLE_MS[msg.device.browserFamily], calibratedOffsetMs: null,
              assignment: null, connected: true, audioReadyTrackId: null,
            };
        room.clients[rec.id] = rec;
        if (rec.kind === "host" && !room.hostClientIds.includes(rec.id)) room.hostClientIds.push(rec.id);
        /*
         * And the converse, which `apps/server` does not need yet because there a host record can only
         * ever stay a host: authority lives in `hostClientIds` (`isHost` is derived from it), so a record
         * that just asked to become a read-only viewer must lose it in the same breath. A JOIN is allowed
         * to *drop* privilege — that can never be an attack — and must never silently keep it.
         */
        if (rec.kind !== "host") room.hostClientIds = room.hostClientIds.filter((id) => id !== rec.id);
        ws.data.clientId = rec.id;
        sockets.set(rec.id, ws);
        members.add(ws);
        ws.subscribe(room.code); // PING is still a topic broadcast; ROOM_STATE is not (see sendState)
        clearDisconnectTimer(rec.id);
        health.set(rec.id, { rttMs: null, syncErrMs: null, outputLatencyMs: null, audioState: "locked", lastSeenServerTime: now() });
        send(ws, { type: "WELCOME", clientId: rec.id, roomCode: room.code, serverTime: now(), protocolVersion: PROTOCOL_VERSION, isHost: rec.kind === "host" });
        replan();
        // A joiner gets its snapshot immediately — its own view of the room, like everyone else's: the
        // server has no separate "initial state" either, a JOIN is one more change that is published.
        flush();
        log(`join ${rec.kind} ${rec.name} (${rec.id})`);
        return;
      }
      case "NTP_REQUEST": {
        const t1 = now();
        return send(ws, { type: "NTP_RESPONSE", t0: msg.t0, t1, t2: now(), probeGroupId: msg.probeGroupId, probeGroupIndex: msg.probeGroupIndex });
      }
      case "PONG":
        if (me) health.get(me.id)!.lastSeenServerTime = now();
        return;
      case "CLIENT_STATUS":
        if (me) {
          health.set(me.id, { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs: msg.outputLatencyMs, audioState: msg.audioState, lastSeenServerTime: now() });
          // Live latency (as the server): a phone that reports its own ctx.outputLatency knows its output
          // path better than the per-family table guess, so the guess is dropped — one-way — and the
          // client subtracts the live value itself. Never both: the same snapshot removes it from
          // compensationMs.
          if (me.calibratedOffsetMs == null && me.tableLatencyMs != null && msg.outputLatencyMs != null && msg.outputLatencyMs > 0) {
            me.tableLatencyMs = null;
            replan();
          }
        }
        return;
      case "AUDIO_READY":
        if (me) { me.audioReadyTrackId = msg.trackId; dirty = true; }
        return;
      case "SET_PLAYS":
        if (me && me.kind === "host") { me.plays = msg.plays; replan(); }
        return;
      case "SET_TRACK": {
        if (!hostOnly()) return;
        const track = library.find((t) => t.id === msg.trackId);
        // An unknown id is an error and changes nothing — it used to stop the music silently.
        if (!track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: `unknown track ${msg.trackId}` });
        setTrack(track);
        room.transport = { state: "stopped" };
        cancelSceneTimer();
        cancelLoopTimer();
        replan();
        return;
      }
      case "TRANSPORT": {
        if (!hostOnly()) return;
        if (!room.track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: "SET_TRACK first" });
        const t = now();
        if (msg.action === "PLAY" || msg.action === "SEEK") {
          const from = msg.trackTimeSec ?? (room.transport.state === "paused" ? room.transport.trackTimeAtPause : 0);
          room.transport = { state: "playing", serverTimeAtTrackZero: t + LEAD_MS - from * 1000 };
          dirty = true;
          syncModeToScenePlan();
          rearmSceneTimer();
          rearmLoopTimer();
        } else if (msg.action === "PAUSE" && room.transport.state === "playing") {
          room.transport = { state: "paused", trackTimeAtPause: trackTimeSec(room.transport, t) };
          dirty = true;
          cancelSceneTimer();
          cancelLoopTimer();
        }
        return;
      }
      case "SET_MODE":
        if (!hostOnly()) return;
        room.mode = { kind: msg.mode, params: msg.params };
        room.scenePlan = null; // manual override clears the plan
        cancelSceneTimer();
        replan();
        return;
      case "ASSIGN":
        if (!hostOnly()) return;
        if (room.clients[msg.clientId]) { room.clients[msg.clientId]!.pinnedRole = msg.role; replan(); }
        return;
      case "SET_POSITION":
        if (!hostOnly()) return;
        if (room.clients[msg.clientId]) { room.clients[msg.clientId]!.position = { x: msg.x, y: msg.y }; replan(); }
        return;
      case "NUDGE":
        if (!(isHost || (me && me.id === msg.clientId))) return;
        if (room.clients[msg.clientId]) { room.clients[msg.clientId]!.nudgeMs = msg.nudgeMs; replan(); }
        return;
      case "KICK":
        if (!hostOnly()) return;
        if (room.clients[msg.clientId]) {
          // Every socket of that client, not only the newest (as the server).
          for (const s of [...members]) {
            if (s.data.clientId !== msg.clientId) continue;
            send(s, { type: "ERROR", code: "KICKED", message: "removed by host" });
            members.delete(s);
            s.close();
          }
          sockets.delete(msg.clientId);
          clearDisconnectTimer(msg.clientId);
          delete room.clients[msg.clientId];
          room.hostClientIds = room.hostClientIds.filter((id) => id !== msg.clientId);
          replan();
        }
        return;
      case "CALIBRATION_START":
        if (!hostOnly()) return;
        return startCalibration(msg.referenceClientId);
      case "CALIBRATION_CANCEL":
        if (!hostOnly()) return;
        return cancelCalibration();
      case "CALIBRATION_RESET":
        if (!hostOnly()) return;
        return resetCalibration(ws, msg.clientId);
      case "CALIBRATION_REPORT": {
        // Only the reference phone measures; anyone else's "report" is noise (or an attack on the offsets).
        if (!me || me.id !== room.calibration.referenceClientId) return;
        // A cancelled or timed-out run writes nothing, even if the reference's report was already in flight.
        if (room.calibration.state === "idle" || room.calibration.state === "failed") return;
        for (const m of msg.measurements) {
          const c = room.clients[m.clientId];
          if (!c || m.confidence < 0.5) continue; // low-confidence peaks are ignored, as index.ts promises
          /*
           * P0-6. The accumulation base must match what the client was ALREADY subtracting when the
           * click was measured, or the first pass makes things worse. With no table row (browserFamily
           * "other") the engine subtracts `ctx.outputLatency` itself, so the residual was measured with
           * it applied — but writing `calibratedOffsetMs` makes the engine stop subtracting it. A base of
           * 0 would leave the phone late by exactly its output latency until a second pass. The client
           * reports that number in CLIENT_STATUS, so use it.
           */
          const base = c.calibratedOffsetMs ?? c.tableLatencyMs ?? health.get(m.clientId)?.outputLatencyMs ?? 0;
          c.calibratedOffsetMs = base + m.residualMs;
          room.calibration.results[m.clientId] = { residualMs: m.residualMs, confidence: m.confidence };
        }
        room.calibration = { ...room.calibration, state: "done" };
        replan();
        return;
      }
    }
  }

  function clearCalibrationTimers() {
    for (const t of calibrationTimers) clearTimeout(t);
    calibrationTimers = [];
  }

  /**
   * CALIBRATION_CANCEL: back to idle at once. The SCHEDULED_ACTIONs are already on the wire, so the
   * server cannot un-send them — each client drops its own pending clicks when it sees `idle`
   * (docs/04). Published immediately rather than on the coalescer, because every millisecond of delay
   * is another click the room hears after someone pressed Cancel.
   */
  function cancelCalibration() {
    clearCalibrationTimers();
    room.calibration = IDLE_CALIBRATION;
    dirty = true;
    flush();
  }

  /**
   * CALIBRATION_RESET: throw measured offsets away, for one client or the whole room.
   *
   * Two decisions worth arguing with:
   *
   * 1. **Cleared to `null`, not `0`.** Null falls back through `tableLatencyMs` and then the phone's own
   *    `ctx.outputLatency`; zero is a positive claim that the phone has no output latency, which is
   *    never true. Resetting a measurement must not be worse than never having measured.
   * 2. **Refused mid-run.** A residual is measured against whatever compensation the phone was applying
   *    when its click sounded. Clearing the base between the clicks and the report would add those
   *    residuals to a *different* base — writing in exactly the error the host was trying to undo. So a
   *    reset during `countdown`/`running`/`done` is an error, not a silent partial success: cancel, then
   *    reset. (`done` is included because its report may still be in flight from the reference.)
   */
  function resetCalibration(ws: Bun.ServerWebSocket<{ clientId: string | null }>, clientId?: string) {
    if (room.calibration.state !== "idle") {
      return send(ws, {
        type: "ERROR",
        code: "CALIBRATION_BUSY",
        message: `cannot reset while calibration is ${room.calibration.state}: cancel first`,
      });
    }
    const targets = clientId ? [room.clients[clientId]] : Object.values(room.clients);
    if (clientId && !room.clients[clientId]) {
      return send(ws, { type: "ERROR", code: "NO_CLIENT", message: `no client ${clientId}` });
    }
    for (const c of targets) {
      if (c) c.calibratedOffsetMs = null;
    }
    // replan(), because each client's compensationMs is derived from the offsets we just cleared; it
    // sets `dirty` itself. Flushed rather than coalesced so the host sees the offsets go.
    replan();
    flush();
  }

  /** Simulated tuning moment: countdown, one click per speaker every CALIBRATION_CLICK_INTERVAL_MS, fake residuals for mock players. */
  function startCalibration(referenceClientId: string) {
    /*
     * Only a connected speaker can produce a click worth measuring; anyone else is a silent slot.
     *
     * Like the server, a speaker must also have announced AUDIO_READY for the current track
     * (REQUIRE_AUDIO_READY_FOR_CALIBRATION): a phone still loading cannot click on time.
     */
    const order = Object.values(room.clients)
      .filter((c) => c.plays && c.id !== referenceClientId && c.connected && (!REQUIRE_AUDIO_READY_FOR_CALIBRATION || c.audioReadyTrackId === room.track?.id))
      .sort((a, b) => a.joinIndex - b.joinIndex)
      .map((c) => c.id);
    const start = now() + CALIBRATION_COUNTDOWN_MS;
    room.calibration = { state: "countdown", referenceClientId, startServerTime: start, order, results: {} };
    dirty = true;
    const ref = sockets.get(referenceClientId);
    if (ref) send(ref, { type: "CALIBRATION_PLAN", startServerTime: start, intervalMs: CALIBRATION_CLICK_INTERVAL_MS, order, clickSpec: DEFAULT_CLICK_SPEC });
    order.forEach((id, i) => {
      const at = start + i * CALIBRATION_CLICK_INTERVAL_MS;
      const s = sockets.get(id);
      if (s) send(s, { type: "SCHEDULED_ACTION", serverTimeToExecute: at, action: { kind: "CALIBRATION_CLICK", clickId: `${id}:${i}`, clickSpec: DEFAULT_CLICK_SPEC } });
    });
    clearCalibrationTimers();
    calibrationTimers.push(setTimeout(() => {
      if (room.calibration.state !== "countdown") return; // cancelled during the countdown
      room.calibration = { ...room.calibration, state: "running" };
      dirty = true;
    }, CALIBRATION_COUNTDOWN_MS));
    // No report in time → failed (as the server): the reference never heard the clicks, or left.
    calibrationTimers.push(setTimeout(() => {
      if (room.calibration.state === "idle" || room.calibration.state === "done") return;
      room.calibration = { ...room.calibration, state: "failed" };
      dirty = true;
      flush();
    }, CALIBRATION_COUNTDOWN_MS + order.length * CALIBRATION_CLICK_INTERVAL_MS + 5000));
    // mock players "get measured" on schedule; real players are measured by the reference's CALIBRATION_REPORT
    order.forEach((id, i) => {
      if (!id.startsWith("mock-")) return;
      calibrationTimers.push(setTimeout(() => {
        if (room.calibration.state === "idle") return; // cancelled: measure nothing
        room.calibration.results[id] = { residualMs: Math.round(((i * 7) % 23) - 11), confidence: 0.9 };
        dirty = true;
        if (Object.keys(room.calibration.results).length >= order.length) { room.calibration = { ...room.calibration, state: "done" }; }
      }, CALIBRATION_COUNTDOWN_MS + (i + 1) * CALIBRATION_CLICK_INTERVAL_MS));
    });
  }

  /** As the server: one room-level flag, because a guest's own snapshot there has no roster to read it from. */
  function stampHostConnected() {
    room.hostConnected = room.hostClientIds.some((id) => room.clients[id]?.connected === true);
  }

  /**
   * One ROOM_STATE per recipient, as apps/server's `sendState`: a **player** gets `playerRoomView`;
   * **hosts, viewers and observers** get the full room. Seeded `mock-*` players have no socket and so
   * are nobody's recipient. This used to be one `server.publish` of the whole room to everyone.
   */
  function sendState() {
    stampHostConnected();
    let full: string | null = null;
    const fullView = () => (full ??= JSON.stringify({ type: "ROOM_STATE", room } satisfies ServerMessage));
    for (const ws of members) {
      const rec = ws.data.clientId ? room.clients[ws.data.clientId] : undefined;
      if (!rec) continue;
      ws.send(rec.kind === "player" ? JSON.stringify({ type: "ROOM_STATE", room: playerRoomView(room, rec.id) } satisfies ServerMessage) : fullView());
    }
    for (const ws of observers) ws.send(fullView());
  }

  function flush() {
    if (!dirty) return;
    dirty = false;
    sendState();
  }

  const stateTimer = setInterval(flush, 1000 / ROOM_STATE_MAX_HZ);
  const healthTimer = setInterval(() => {
    const t = now();
    const clients: Record<string, NonNullable<ReturnType<typeof health.get>>> = {};
    for (const [id, h] of health) if (room.clients[id]) clients[id] = h;
    // Hosts and viewers both get HEALTH: a projector display's "Synced ±N ms" tile is a median over
    // exactly these numbers, and it is the one thing a viewer cannot derive from ROOM_STATE.
    const watchers = new Set([...room.hostClientIds, ...Object.values(room.clients).filter((c) => c.kind === "viewer").map((c) => c.id)]);
    for (const id of watchers) {
      const s = sockets.get(id);
      if (s) send(s, { type: "HEALTH", serverTime: t, clients });
    }
    for (const s of observers) send(s, { type: "HEALTH", serverTime: t, clients });
  }, 1000 / HEALTH_HZ);
  const pingTimer = setInterval(() => server.publish(room.code, JSON.stringify({ type: "PING", serverTime: now() } satisfies ServerMessage)), 20_000);

  /**
   * Drop every live socket with 1012 (service restart) while keeping the room. That is what a real
   * restart behind a restored room looks like to a phone — and it is the interesting case, because the
   * timeline survives, so every phone must come back to the *same* position rather than to a new one.
   */
  function simulateRestart(opts: { wipe?: boolean } = {}) {
    log(`chaos: simulating server restart${opts.wipe ? " (room re-created empty)" : ""}`);
    for (const s of [...members]) s.close(1012, "mock restart");
    members.clear();
    sockets.clear();
    if (opts.wipe) wipeRoom();
    else for (const c of Object.values(room.clients)) if (!c.id.startsWith("mock-")) c.connected = false;
    dirty = true;
  }

  /**
   * What the room is after a real restart, once the host's key has re-created it (apps/server
   * `Room` constructor): a new `createdAtServerTime`, no track, stopped, UNISON, no plan, no tuning,
   * and nobody in it — every phone joins again as a new record. The seeded `mock-*` players have no
   * socket to rejoin with, so they are simply seeded again (unmeasured, as a rejoined phone is).
   */
  function wipeRoom() {
    for (const s of [...observers]) s.close(1012, "mock restart");
    observers.clear();
    clearCalibrationTimers();
    cancelSceneTimer();
    cancelLoopTimer();
    for (const t of disconnectTimers.values()) clearTimeout(t);
    disconnectTimers.clear();
    health.clear();
    joinCounter = 0;
    room = {
      code: room.code,
      protocolVersion: PROTOCOL_VERSION,
      createdAtServerTime: now(),
      hostClientIds: [],
      track: null,
      transport: { state: "stopped" },
      mode: { kind: "UNISON", params: {} },
      scenePlan: null,
      calibration: IDLE_CALIBRATION,
      clients: {},
    };
    seedPlayers();
    replan();
  }

  let chaosTimer: ReturnType<typeof setTimeout> | null = null;
  if (scenario.chaos) {
    const { wipe } = scenario.chaos;
    chaosTimer = setTimeout(() => simulateRestart({ wipe }), scenario.chaos.restartAfterSec * 1000);
  }

  const ready = (async () => {
    library = await loadLibrary(fixturesDir);
    seedPlayers();
    setTrack(library.find((t) => t.id === scenario.trackId) ?? library[0]);
    if (scenario.transport === "playing") {
      room.transport = { state: "playing", serverTimeAtTrackZero: now() + LEAD_MS };
      rearmSceneTimer();
      rearmLoopTimer();
    }
    if (scenario.transport === "paused") room.transport = { state: "paused", trackTimeAtPause: 12 };
    if (scenario.hostPlays) { /* hosts join live; flag honored on JOIN via SET_PLAYS */ }
    if (scenario.calibration) {
      const order = Object.keys(room.clients);
      const results: RoomState["calibration"]["results"] = {};
      order.slice(0, scenario.calibration.doneCount).forEach((id, i) => { results[id] = { residualMs: (i * 9) % 20 - 8, confidence: 0.85 }; });
      room.calibration = { state: scenario.calibration.state, referenceClientId: null, startServerTime: now(), order, results };
    }
    replan();
    log(`listening on http://localhost:${port}  ws://localhost:${port}/ws  room ${room.code}  scenario players=${scenario.players.length}`);
  })();

  return {
    server, port, hostKey, ready,
    get room() { return room; },
    /** How many of each client message this server has handled (diagnostics; see `handle`). */
    get received() { return received; },
    /** Drop every socket as a restart would, keeping the room — or, with `{ wipe: true }`, re-creating it empty (see `simulateRestart`). */
    simulateRestart,
    stop() {
      clearInterval(stateTimer); clearInterval(healthTimer); clearInterval(pingTimer);
      clearCalibrationTimers();
      cancelSceneTimer();
      cancelLoopTimer();
      for (const t of disconnectTimers.values()) clearTimeout(t);
      disconnectTimers.clear();
      if (chaosTimer) clearTimeout(chaosTimer);
      server.stop(true);
    },
  };
}

// ---- CLI --------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--scenario");
  const path = i >= 0 ? args[i + 1] : process.env.MOCK_SCENARIO;
  const scenario = path ? ScenarioSchema.parse(await Bun.file(path).json()) : ScenarioSchema.parse({
    players: [
      { name: "Maya", browserFamily: "ios-safari", position: [0.25, 0.3], health: "good" },
      { name: "Sam", browserFamily: "android-chrome", position: [0.7, 0.25], health: "good" },
      { name: "Ari", browserFamily: "ios-safari", position: [0.5, 0.55], health: "warn" },
      { name: "Lee", browserFamily: "desktop-chrome", position: [0.2, 0.75], health: "good" },
      { name: "Kim", browserFamily: "android-chrome", position: [0.85, 0.65], health: "bad" },
      { name: "Noor", browserFamily: "ios-safari", position: [0.55, 0.85], health: "good" },
    ],
    mode: { kind: "ORCHESTRA", params: {} },
    transport: "playing",
  });
  const m = startMockServer({ scenario });
  await m.ready;
}
