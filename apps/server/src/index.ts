// HiveMusic room server — see agents/SERVER-AGENT.md. Port of packages/protocol/src/mock-server.ts to real,
// multi-room state: Bun.serve with WS + REST, the shared planner, and the vibe director.
import { PROTOCOL_VERSION, VibeRequestSchema, type ScenePlan } from "@hive/protocol";
import { directScene } from "./vibe/director";
import { readDropSec } from "./vibe/track-meta";
import { RoomManager, type Conn } from "./rooms";

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
      const dropSec = track ? await readDropSec(FIXTURES_DIR, track.id) : undefined;
      const scenePlan: ScenePlan = await directScene(
        parsed.data.prompt,
        {
          title: track?.title ?? "untitled",
          durationSec,
          stems: track?.stems ?? ["mix"],
          bpm: track?.bpm,
          dropSec,
          energy: entry?.energy,
        },
        Object.values(room.room.clients).filter((c) => c.plays && c.connected).length,
        room.room.mode.kind,
        performance.timeOrigin + performance.now(),
      );
      room.acceptScenePlan(scenePlan);
      return json({ scenePlan });
    }

    if (url.pathname === "/tracks") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const tracks = manager.getLibrary().filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.includes(q));
      return json({ tracks });
    }

    const audio = url.pathname.match(/^\/audio\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\.wav$/);
    if (audio) {
      const f = Bun.file(`${FIXTURES_DIR}/tracks/${audio[1]}/${audio[2]}.wav`);
      if (await f.exists()) {
        return new Response(f, { headers: { ...corsHeaders, "Content-Type": "audio/wav", "Cache-Control": "public, max-age=31536000, immutable" } });
      }
      return json({ error: "not found; run `bun run fixtures`" }, 404);
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
await manager.loadLibrary(`http://localhost:${server.port}`);

console.log(`[hive-server] listening on http://localhost:${server.port} (protocol v${PROTOCOL_VERSION}, cors ${CORS_ORIGIN})`);
