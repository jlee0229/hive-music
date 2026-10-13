/**
 * A server that only listens: it records every JOIN (and every `/vibe` request) a client sends, answers
 * WELCOME, and can drop its sockets on demand. For tests about what the client puts on the wire —
 * identity, `plays`, keys — where the mock server's own logic would only be in the way.
 */
import { PROTOCOL_VERSION } from "@hive/protocol";

export interface RecordedJoin {
  clientId: string;
  kind: string;
  plays: boolean;
  hostKey?: string;
  libraryKey?: string;
  protocolVersion: number;
  /** The raw frame, for "this string must not appear anywhere" checks. */
  raw: string;
}

export interface RecordedVibe {
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

export interface RecordingServerOptions {
  /** What WELCOME claims; defaults to this bundle's version. */
  protocolVersion?: number | (() => number);
  /** Status for POST /rooms/:code/vibe (default 200 with a one-scene plan). */
  vibeStatus?: number;
  /** What WELCOME.isHost says for a JOIN; defaults to "it asked to be a host". */
  isHost?: (join: RecordedJoin) => boolean;
}

export function startRecordingServer(opts: RecordingServerOptions = {}) {
  const joins: RecordedJoin[] = [];
  const vibes: RecordedVibe[] = [];
  const frames: string[] = [];
  const sockets = new Set<{ close(code?: number, reason?: string): void }>();
  const port = 16000 + Math.floor(Math.random() * 900);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type, Authorization" };
  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/vibe")) {
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
        vibes.push({
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: await req.json().catch(() => null),
        });
        const status = opts.vibeStatus ?? 200;
        if (status !== 200) return new Response(JSON.stringify({ error: "refused" }), { status, headers: cors });
        const scenePlan = { prompt: "x", source: "rules", scenes: [{ atTrackSec: 0, mode: "UNISON", params: {}, note: "" }] };
        return new Response(JSON.stringify({ scenePlan }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
      }
      return srv.upgrade(req) ? undefined : new Response("ws only", { status: 400 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const text = String(raw);
        frames.push(text);
        const msg = JSON.parse(text) as { type: string } & Record<string, unknown>;
        if (msg.type !== "JOIN") return;
        const join = { ...(msg as unknown as Omit<RecordedJoin, "raw">), raw: text };
        joins.push(join);
        const version = typeof opts.protocolVersion === "function" ? opts.protocolVersion() : (opts.protocolVersion ?? PROTOCOL_VERSION);
        ws.send(JSON.stringify({ type: "WELCOME", clientId: msg.clientId, roomCode: msg.roomCode, serverTime: Date.now(), protocolVersion: version, isHost: opts.isHost ? opts.isHost(join) : msg.kind === "host" }));
      },
    },
  });
  return {
    port,
    joins,
    vibes,
    frames,
    urls: { wsUrl: `ws://localhost:${port}/ws`, apiUrl: `http://localhost:${port}`, roomCode: "BZQ7" },
    /** Closes every socket from the server side: the client sees a dropped connection and reconnects. */
    dropAll(): void {
      for (const s of [...sockets]) s.close(1012, "test: dropped");
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
