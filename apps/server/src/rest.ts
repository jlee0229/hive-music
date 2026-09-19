/**
 * REST surface (docs/02-protocol.md §6). CORS headers go on every response, including errors and 404s,
 * because the phone's browser will refuse to read a bare failure otherwise.
 */
import { PROTOCOL_VERSION } from "@hive/protocol";
import { serverNow } from "./clock";
import type { ServerConfig } from "./config";
import type { TrackLibrary } from "./library";
import type { RoomRegistry } from "./rooms";

export interface RestDeps {
  config: ServerConfig;
  library: TrackLibrary;
  rooms: RoomRegistry;
  /** POST /rooms/:code/vibe — installed at B6; a 503 until then. */
  vibe?: (code: string, prompt: string) => Promise<Response>;
}

const AUDIO_RE = /^\/audio\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,32})\.wav$/;
const ROOM_RE = /^\/rooms\/([A-Za-z0-9]{3,8})$/;
const VIBE_RE = /^\/rooms\/([A-Za-z0-9]{3,8})\/vibe$/;

export function corsHeaders(config: ServerConfig): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

/** Handles every non-WebSocket request; the `/ws` upgrade is taken in server.ts before this runs. */
export async function handleRest(req: Request, deps: RestDeps): Promise<Response> {
  const { config, library, rooms } = deps;
  const url = new URL(req.url);
  const cors = corsHeaders(config);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (url.pathname === "/health" && req.method === "GET") {
    return json({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: serverNow() });
  }

  if (url.pathname === "/rooms" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const requested = typeof body.code === "string" && /^[A-Za-z0-9]{3,8}$/.test(body.code) ? body.code : undefined;
    const room = rooms.create(requested);
    return json({ code: room.code, hostKey: room.hostKey, joinUrl: `${config.webUrl}/j/${room.code}` });
  }

  const roomMatch = url.pathname.match(ROOM_RE);
  if (roomMatch && req.method === "GET") {
    const code = roomMatch[1]!.toUpperCase();
    const room = rooms.get(code);
    return json({ code, exists: !!room, players: room?.playerCount() ?? 0 }, room ? 200 : 404);
  }

  const vibeMatch = url.pathname.match(VIBE_RE);
  if (vibeMatch && req.method === "POST") {
    if (!deps.vibe) return json({ error: "vibe_unavailable" }, 503);
    const body = (await req.json().catch(() => ({}))) as { prompt?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 500) : "";
    if (!prompt) return json({ error: "prompt_required" }, 400);
    return deps.vibe(vibeMatch[1]!.toUpperCase(), prompt);
  }

  if (url.pathname === "/tracks" && req.method === "GET") {
    return json({ tracks: library.entries(url.origin, url.searchParams.get("q") ?? "") });
  }

  const audioMatch = url.pathname.match(AUDIO_RE);
  if (audioMatch && (req.method === "GET" || req.method === "HEAD")) {
    return serveAudio(req, library, audioMatch[1]!, audioMatch[2]!, cors);
  }

  return json({ error: "not_found", path: url.pathname }, 404);
}

/**
 * Serves one stem. Single-range requests are honoured because iOS media loading sometimes probes with
 * `Range: bytes=0-1` before fetching the body; a 200 to a range request makes WebKit retry or give up.
 */
async function serveAudio(
  req: Request,
  library: TrackLibrary,
  trackId: string,
  stem: string,
  cors: Record<string, string>,
): Promise<Response> {
  const path = library.stemPath(trackId, stem);
  const file = path ? Bun.file(path) : null;
  if (!file || !(await file.exists())) {
    return new Response(JSON.stringify({ error: "not_found", hint: "run `bun run fixtures`" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  const base = {
    ...cors,
    "Content-Type": "audio/wav",
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.get("range");
  const size = file.size;
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (!Number.isFinite(start) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(req.method === "HEAD" ? null : file, {
    headers: { ...base, "Content-Length": String(size) },
  });
}
