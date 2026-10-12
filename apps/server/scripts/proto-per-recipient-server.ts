#!/usr/bin/env bun
// PROTOTYPE, for measurement only — not the proposed patch, and never deployed.
//
// The real server with one thing replaced at runtime: how a ROOM_STATE is fanned out. Instead of
// `server.publish(code, <whole room>)` to every socket, each recipient is sent what it reads:
//   - hosts and viewers: the full snapshot, exactly as today;
//   - players: the room-level state plus a roster of exactly one record — their own. That message is
//     a valid ROOM_STATE under today's schema (see src/__tests__/scale-per-recipient.test.ts), so no
//     client changes.
// PROTO_DEDUPE=1 additionally skips a socket whose message is byte-identical to the last one it was
// sent (a dragged dot then reaches the host and that one phone, not the whole room), and
// PROTO_BACKPRESSURE_BYTES=<n> skips a socket that still has more than n bytes queued (the next
// snapshot supersedes this one anyway).
//
// Use it through the load test, which then measures it with the same instrument as the real server:
//   bun apps/server/scripts/load-test.ts --clients 100 --server-entry apps/server/scripts/proto-per-recipient-server.ts
//
// It patches Room.prototype.flush from the outside, so apps/server/src is untouched. Only the routes
// the load scripts use are served (/ws, /health, POST /rooms, GET /tracks).
import { PROTOCOL_VERSION, ROOM_STATE_MAX_HZ, type ClientRecord, type RoomState } from "@hive/protocol";
import { withUrls } from "../src/library";
import { Room, RoomManager, type Conn } from "../src/rooms";

const PORT = Number(process.env.PORT ?? 8880);
const DEDUPE = process.env.PROTO_DEDUPE === "1";
const BACKPRESSURE_BYTES = Number(process.env.PROTO_BACKPRESSURE_BYTES ?? 0);
const now = () => performance.timeOrigin + performance.now();

type WS = Bun.ServerWebSocket<Conn>;
interface RoomInternals {
  code: string;
  room: RoomState;
  sockets: Map<string, WS>;
  dirty: boolean;
  lastPublishAt: number;
  trailingTimer: ReturnType<typeof setTimeout> | null;
  flush(): void;
}
const lastSent = new WeakMap<WS, string>();

function fanOut(r: RoomInternals) {
  const { clients, calibration, ...rest } = r.room;
  let full: string | null = null;
  // Players never read the calibration order/results (the reference gets them in CALIBRATION_PLAN and is a host).
  const head = JSON.stringify({ ...rest, calibration: { ...calibration, order: [], results: {} } }).slice(0, -1);
  for (const [id, ws] of r.sockets) {
    if (BACKPRESSURE_BYTES && ws.getBufferedAmount() > BACKPRESSURE_BYTES) continue;
    const c: ClientRecord | undefined = clients[id];
    let msg: string;
    if (!c || c.kind !== "player") msg = full ??= JSON.stringify({ type: "ROOM_STATE", room: r.room });
    else msg = `{"type":"ROOM_STATE","room":${head},"clients":{${JSON.stringify(id)}:${JSON.stringify(c)}}}}`;
    if (DEDUPE) {
      if (lastSent.get(ws) === msg) continue;
      lastSent.set(ws, msg);
    }
    ws.send(msg);
  }
}

// Same leading-edge coalescing as Room.flush (rooms.ts), with the publish swapped for fanOut.
(Room.prototype as unknown as RoomInternals).flush = function (this: RoomInternals) {
  if (!this.dirty) return;
  const minGapMs = 1000 / ROOM_STATE_MAX_HZ;
  const elapsed = now() - this.lastPublishAt;
  if (elapsed >= minGapMs) {
    this.dirty = false;
    this.lastPublishAt = now();
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = null;
    }
    fanOut(this);
  } else if (!this.trailingTimer) {
    this.trailingTimer = setTimeout(() => {
      this.trailingTimer = null;
      this.flush();
    }, minGapMs - elapsed + 20);
  }
};

const cors = { "Access-Control-Allow-Origin": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
const manager = new RoomManager({ fixturesDir: process.env.FIXTURES_DIR ?? `${import.meta.dir}/../../../fixtures`, fixedCode: process.env.ROOM_FIXED_CODE || undefined });

const server = Bun.serve<Conn>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return srv.upgrade(req, { data: { clientId: null, roomCode: null } }) ? undefined : new Response("upgrade failed", { status: 400 });
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, protocolVersion: PROTOCOL_VERSION, prototype: "per-recipient", serverTime: now() });
    if (req.method === "POST" && url.pathname === "/rooms") {
      const result = manager.createRoom(((await req.json().catch(() => ({}))) as { code?: string }).code);
      return "error" in result ? json({ error: result.error }, 400) : json(result);
    }
    if (req.method === "GET" && url.pathname === "/tracks") return json({ tracks: manager.getLibrary().map((t) => withUrls(t, url.origin)) });
    return json({ error: "not_found" }, 404);
  },
  websocket: {
    message: (ws, raw) => manager.handleMessage(ws, raw),
    close: (ws) => manager.handleClose(ws),
  },
});
manager.attachServer(server);
await manager.loadLibrary();
console.log(`[proto-per-recipient] listening on http://localhost:${server.port} dedupe=${DEDUPE} backpressureBytes=${BACKPRESSURE_BYTES}`);
