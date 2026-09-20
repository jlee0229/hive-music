// HiveMusic room server — see agents/SERVER-AGENT.md. Port of packages/protocol/src/mock-server.ts to real,
// multi-room state: Bun.serve with WS + REST, the shared planner, and the vibe director.
import { PROTOCOL_VERSION, VibeRequestSchema, type ScenePlan } from "@hive/protocol";
import { directScene } from "./vibe/director";
import { withUrls } from "./library";
import { RoomManager, type Conn } from "./rooms";
import { handleUploadTracks } from "./upload/route";

const PORT = Number(process.env.PORT ?? 8080);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const FIXTURES_DIR = process.env.FIXTURES_DIR ?? `${import.meta.dir}/../../../fixtures`;
const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000";
const FIXED_CODE = process.env.ROOM_FIXED_CODE;

const corsHeaders = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

const manager = new RoomManager({ fixturesDir: FIXTURES_DIR, fixedCode: FIXED_CODE });

const server = Bun.serve<Conn>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: { clientId: null, roomCode: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: performance.timeOrigin + performance.now() });
    }

    if (req.method === "POST" && url.pathname === "/rooms") {
      const body = (await req.json().catch(() => ({}))) as { code?: string };
      const result = manager.createRoom(body.code);
      if ("error" in result) return json({ error: result.error }, 400);
      return json({ code: result.code, hostKey: result.hostKey, joinUrl: `${WEB_URL}/j/${result.code}` });
    }

    const roomMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)$/);
    if (roomMatch && req.method === "GET") {
      const summary = manager.getSummary(roomMatch[1]!);
      return json(summary, summary.exists ? 200 : 404);
    }

    const vibeMatch = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)\/vibe$/);
    if (vibeMatch && req.method === "POST") {
      const room = manager.get(vibeMatch[1]!);
      if (!room) return json({ error: "no such room" }, 404);
      const parsed = VibeRequestSchema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) return json({ error: "bad prompt" }, 400);
      const track = room.room.track;
      const durationSec = track?.durationSec ?? 60;
      const entry = manager.getLibrary().find((t) => t.id === track?.id);
      const scenePlan: ScenePlan = await directScene(
        parsed.data.prompt,
        {
          title: track?.title ?? "untitled",
          durationSec,
          stems: track?.stems ?? ["mix"],
          bpm: track?.bpm,
          dropSec: entry?.dropSec,
          energy: entry?.energy,
        },
        Object.values(room.room.clients).filter((c) => c.plays && c.connected).length,
        room.room.mode.kind,
        performance.timeOrigin + performance.now(),
      );
      room.acceptScenePlan(scenePlan);
      return json({ scenePlan });
    }

    if (url.pathname === "/tracks" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const tracks = manager
        .getLibrary()
        .filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.includes(q))
        .map((t) => withUrls(t, url.origin));
      return json({ tracks });
    }

    if (url.pathname === "/tracks" && req.method === "POST") {
      return handleUploadTracks(req, manager, FIXTURES_DIR, url.origin, corsHeaders);
    }

    const audio = url.pathname.match(/^\/audio\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.wav$/);
    if (audio) {
      const f = Bun.file(`${FIXTURES_DIR}/tracks/${audio[1]}/${audio[2]}.wav`);
      if (!(await f.exists())) return json({ error: "not found; run `bun run fixtures`" }, 404);
      const audioHeaders = { ...corsHeaders, "Content-Type": "audio/wav", "Cache-Control": "public, max-age=31536000, immutable", "Accept-Ranges": "bytes" };
      // iOS Safari probes media with a Range request (often bytes=0-1); a 200 to it makes it retry or
      // give up instead of playing, so a single-range request gets a real 206 (engine's R-1 review).
      const range = req.headers.get("range");
      const match = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (match) {
        const total = f.size;
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          return new Response(null, { status: 416, headers: { ...audioHeaders, "Content-Range": `bytes */${total}` } });
        }
        const clampedEnd = Math.min(end, total - 1);
        return new Response(f.slice(start, clampedEnd + 1), {
          status: 206,
          headers: { ...audioHeaders, "Content-Range": `bytes ${start}-${clampedEnd}/${total}`, "Content-Length": String(clampedEnd - start + 1) },
        });
      }
      return new Response(f, { headers: audioHeaders });
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  },
  websocket: {
    open() {
      /* subscribed to its room's topic once JOIN resolves which room it is */
    },
    message(ws, raw) {
      manager.handleMessage(ws, raw);
    },
    close(ws) {
      manager.handleClose(ws);
    },
  },
});

manager.attachServer(server);
await manager.loadLibrary();

console.log(`[hive-server] listening on http://localhost:${server.port} (protocol v${PROTOCOL_VERSION}, cors ${CORS_ORIGIN})`);
