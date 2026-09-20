/**
 * @hive/protocol mock server — the frontend's stand-in for apps/server until integration.
 * Same schemas, same planner, same routes. Drives itself from a scenario file:
 *   bun run mock --scenario apps/web/mocks/scenarios/party-12.json   (or MOCK_SCENARIO=...)
 * Ports: PORT (default 8080). WebSocket at /ws. REST: /health /rooms /rooms/:code /tracks /audio/:id/:stem.wav /rooms/:code/vibe
 */
import { z } from "zod";
import {
  BROWSER_FAMILIES, CALIBRATION_CLICK_INTERVAL_MS, CALIBRATION_COUNTDOWN_MS, HEALTH_HZ, LEAD_MS, MODES,
  PROTOCOL_VERSION, ROOM_STATE_MAX_HZ, STARTER_LATENCY_TABLE_MS, STEMS,
} from "./constants";
import { DEFAULT_CLICK_SPEC, parseClientMessage, type ClientMessage, type ServerMessage } from "./messages";
import { ModeParamsSchema } from "./mode";
import { withAssignments } from "./planner";
import { IDLE_CALIBRATION, StemRoleSchema, trackTimeSec, type ClientRecord, type RoomState, type TrackInfo } from "./room";
import type { TrackLibraryEntry } from "./rest";
import { ScenePlanCoreSchema, type ScenePlan } from "./scene";
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
  chaos: z.object({ restartAfterSec: z.number().positive() }).nullable().default(null),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

const now = () => performance.timeOrigin + performance.now();
const HEALTH_SYNC_ERR: Record<HealthLevel, number | null> = { good: 3, warn: 12, bad: 38, unknown: null };

// ---- track library (fixtures) ----------------------------------------------
async function loadLibrary(fixturesDir: string, origin: string): Promise<TrackLibraryEntry[]> {
  const out: TrackLibraryEntry[] = [];
  const glob = new Bun.Glob("*/meta.json");
  try {
    for await (const rel of glob.scan({ cwd: `${fixturesDir}/tracks` })) {
      const meta = await Bun.file(`${fixturesDir}/tracks/${rel}`).json();
      const urls: Record<string, string> = {};
      for (const s of meta.stems as string[]) urls[s] = `${origin}/audio/${meta.id}/${s}.wav`;
      out.push({ id: meta.id, title: meta.title, durationSec: meta.durationSec, stems: meta.stems, bpm: meta.bpm, urls, energy: meta.energy, clickTimesSec: meta.clickTimesSec, dropSec: meta.dropSec, generated: meta.generated });
    }
  } catch {
    /* no fixtures dir: fall through */
  }
  if (out.length === 0) {
    const urls: Record<string, string> = {};
    for (const s of STEMS) urls[s] = `${origin}/audio/synthetic-60s/${s}.wav`;
    out.push({ id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: [...STEMS], bpm: 120, urls, generated: true });
  }
  return out;
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

  let library: TrackLibraryEntry[] = [];
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
  let dirty = false;
  let calibrationTimers: ReturnType<typeof setTimeout>[] = [];

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

  function setTrack(t: TrackLibraryEntry | undefined) {
    if (!t) return;
    const info: TrackInfo = { id: t.id, title: t.title, durationSec: t.durationSec, stems: t.stems, bpm: t.bpm };
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

  const server = Bun.serve<{ clientId: string | null }>({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const cors = { "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (url.pathname === "/ws") {
        return srv.upgrade(req, { data: { clientId: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return json({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: now(), mock: true });
      if (url.pathname === "/rooms" && req.method === "POST") {
        return json({ code: room.code, hostKey, joinUrl: `${process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000"}/j/${room.code}` });
      }
      const roomMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)$/);
      if (roomMatch && req.method === "GET") {
        const exists = roomMatch[1]!.toUpperCase() === room.code;
        return json({ code: roomMatch[1]!.toUpperCase(), exists, players: exists ? Object.values(room.clients).filter((c) => c.kind === "player").length : 0 }, exists ? 200 : 404);
      }
      const vibeMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)\/vibe$/);
      if (vibeMatch && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { prompt?: string };
        const prompt = String(body.prompt ?? "").slice(0, 500) || "untitled vibe";
        const dur = room.track?.durationSec ?? 60;
        const scenePlan: ScenePlan = {
          prompt, source: "rules", createdAtServerTime: now(),
          scenes: [
            { atTrackSec: 0, mode: "UNISON", params: {}, note: "open" },
            { atTrackSec: Math.round(dur * 0.5), mode: "ORCHESTRA", params: {}, note: "build" },
            { atTrackSec: Math.round(dur * 0.75), mode: "WAVE", params: { axis: "x", spanMs: 240 }, note: "drop" },
          ],
        };
        room.scenePlan = scenePlan;
        dirty = true;
        return json({ scenePlan });
      }
      if (url.pathname === "/tracks") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return json({ tracks: library.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.includes(q)) });
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
      open(ws) {
        ws.subscribe(room.code);
      },
      message(ws, raw) {
        const msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        if (!msg) return send(ws, { type: "ERROR", code: "BAD_MESSAGE", message: "message failed schema validation" });
        handle(ws, msg);
      },
      close(ws) {
        const id = ws.data.clientId;
        if (id && room.clients[id]) {
          room.clients[id]!.connected = false;
          sockets.delete(id);
          dirty = true;
        }
      },
    },
  });

  function handle(ws: Bun.ServerWebSocket<{ clientId: string | null }>, msg: ClientMessage) {
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
        const wantsHost = msg.kind === "host" && (msg.hostKey === hostKey || existing?.kind === "host");
        const rec: ClientRecord = existing
          ? { ...existing, connected: true, name: msg.name ?? existing.name, device: msg.device }
          : {
              id: msg.clientId, kind: wantsHost ? "host" : "player", plays: wantsHost ? msg.plays : true,
              name: msg.name ?? `Phone ${joinCounter + 1}`, device: msg.device,
              joinIndex: joinCounter++, joinedAtServerTime: now(), position: null, pinnedRole: null, nudgeMs: 0,
              tableLatencyMs: STARTER_LATENCY_TABLE_MS[msg.device.browserFamily], calibratedOffsetMs: null,
              assignment: null, connected: true, audioReadyTrackId: null,
            };
        room.clients[rec.id] = rec;
        if (rec.kind === "host" && !room.hostClientIds.includes(rec.id)) room.hostClientIds.push(rec.id);
        ws.data.clientId = rec.id;
        sockets.set(rec.id, ws);
        health.set(rec.id, { rttMs: null, syncErrMs: null, outputLatencyMs: null, audioState: "locked", lastSeenServerTime: now() });
        send(ws, { type: "WELCOME", clientId: rec.id, roomCode: room.code, serverTime: now(), protocolVersion: PROTOCOL_VERSION, isHost: rec.kind === "host" });
        replan();
        flush(); // a joiner gets its snapshot immediately
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
        if (me) health.set(me.id, { rttMs: msg.rttMs, syncErrMs: msg.syncErrMs, outputLatencyMs: msg.outputLatencyMs, audioState: msg.audioState, lastSeenServerTime: now() });
        return;
      case "AUDIO_READY":
        if (me) { me.audioReadyTrackId = msg.trackId; dirty = true; }
        return;
      case "SET_PLAYS":
        if (me && me.kind === "host") { me.plays = msg.plays; replan(); }
        return;
      case "SET_TRACK":
        if (!hostOnly()) return;
        setTrack(library.find((t) => t.id === msg.trackId));
        room.transport = { state: "stopped" };
        replan();
        return;
      case "TRANSPORT": {
        if (!hostOnly()) return;
        if (!room.track) return send(ws, { type: "ERROR", code: "NO_TRACK", message: "SET_TRACK first" });
        const t = now();
        if (msg.action === "PLAY" || msg.action === "SEEK") {
          const from = msg.trackTimeSec ?? (room.transport.state === "paused" ? room.transport.trackTimeAtPause : 0);
          room.transport = { state: "playing", serverTimeAtTrackZero: t + LEAD_MS - from * 1000 };
        } else if (msg.action === "PAUSE" && room.transport.state === "playing") {
          room.transport = { state: "paused", trackTimeAtPause: trackTimeSec(room.transport, t) };
        }
        dirty = true;
        return;
      }
      case "SET_MODE":
        if (!hostOnly()) return;
        room.mode = { kind: msg.mode, params: msg.params };
        room.scenePlan = null; // manual override clears the plan
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
          const s = sockets.get(msg.clientId);
          if (s) { send(s, { type: "ERROR", code: "KICKED", message: "removed by host" }); s.close(); }
          delete room.clients[msg.clientId];
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
        // A cancelled run writes nothing, even if the reference's report was already in flight.
        if (room.calibration.state === "idle") return;
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
    const order = Object.values(room.clients).filter((c) => c.plays && c.id !== referenceClientId).map((c) => c.id);
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

  function flush() {
    if (!dirty) return;
    dirty = false;
    server.publish(room.code, JSON.stringify({ type: "ROOM_STATE", room } satisfies ServerMessage));
  }

  const stateTimer = setInterval(flush, 1000 / ROOM_STATE_MAX_HZ);
  const healthTimer = setInterval(() => {
    const t = now();
    const clients: Record<string, NonNullable<ReturnType<typeof health.get>>> = {};
    for (const [id, h] of health) if (room.clients[id]) clients[id] = h;
    for (const id of room.hostClientIds) {
      const s = sockets.get(id);
      if (s) send(s, { type: "HEALTH", serverTime: t, clients });
    }
  }, 1000 / HEALTH_HZ);
  const pingTimer = setInterval(() => server.publish(room.code, JSON.stringify({ type: "PING", serverTime: now() } satisfies ServerMessage)), 20_000);

  let chaosTimer: ReturnType<typeof setTimeout> | null = null;
  if (scenario.chaos) {
    chaosTimer = setTimeout(() => {
      log(`chaos: simulating server restart (${scenario.chaos!.restartAfterSec}s)`);
      for (const s of sockets.values()) s.close(1012, "mock restart");
      sockets.clear();
      for (const c of Object.values(room.clients)) if (!c.id.startsWith("mock-")) c.connected = false;
      dirty = true;
    }, scenario.chaos.restartAfterSec * 1000);
  }

  const ready = (async () => {
    library = await loadLibrary(fixturesDir, `http://localhost:${port}`);
    seedPlayers();
    setTrack(library.find((t) => t.id === scenario.trackId) ?? library[0]);
    if (scenario.transport === "playing") room.transport = { state: "playing", serverTimeAtTrackZero: now() + LEAD_MS };
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
    stop() {
      clearInterval(stateTimer); clearInterval(healthTimer); clearInterval(pingTimer);
      clearCalibrationTimers();
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
