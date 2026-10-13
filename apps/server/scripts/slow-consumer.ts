#!/usr/bin/env bun
// Backpressure probe: what does the server hold in memory for phones that stop reading?
//
//   bun apps/server/scripts/slow-consumer.ts [--clients 200] [--stalled 10] [--duration 150] [--out <file.json>]
//
// A phone whose tab is frozen (screen locked, app switched, dead spot on cellular) keeps its TCP
// connection but stops draining it. Every ROOM_STATE published after that is queued for it in the
// server's user-space send buffer. This script joins N ordinary clients (so the snapshot is the size a
// room of N really has) plus K raw-TCP clients that complete the WebSocket handshake, JOIN, and then
// never read again, while the host drags a dot so the room broadcasts at the 2 Hz cap. It prints the
// server's RSS and how many of the stalled sockets the server still counts as connected, every 5 s.
//
// Localhost only: the server is spawned here on a random port in 26000-26899.
import net from "node:net";
import { PROTOCOL_VERSION, type ClientMessage } from "@hive/protocol";
import { readProcStats } from "./lib/proc-stats";
import { parseArgs } from "./lib/stats";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.get("clients") ?? 200);
const K = Number(args.get("stalled") ?? 10);
const DURATION_SEC = Number(args.get("duration") ?? 150);
// --stalled-kind viewer: the stalled sockets are displays, which are sent the whole roster (players
// are sent only their own record since SCALE-NET-02, so they are no longer the worst case).
const STALLED_KIND = (args.get("stalled-kind") ?? "player") as "player" | "viewer";
const PORT = 26000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const device = { userAgent: "", platform: "load-test", browserFamily: "android-chrome" as const };

function join(clientId: string, roomCode: string, kind: "host" | "player" | "viewer", hostKey?: string): ClientMessage {
  return { type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION };
}

/** One masked client->server text frame (RFC 6455 §5.2). */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}

/** Handshake, JOIN, wait for the first bytes back (WELCOME), then stop reading for good. */
function stalledClient(clientId: string, roomCode: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let upgraded = false;
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(`GET /ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on("data", (chunk) => {
      if (!upgraded) {
        if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) return reject(new Error("upgrade refused"));
        upgraded = true;
        sock.write(frame(JSON.stringify(join(clientId, roomCode, STALLED_KIND))));
        return;
      }
      sock.pause(); // from here on the kernel buffer fills and the server has to hold the rest
      sock.removeAllListeners("error");
      sock.on("error", () => {});
      resolve(sock);
    });
  });
}

const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/index.ts`], {
  env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "" },
  stdout: "ignore",
  stderr: "inherit",
});
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    if (i > 100) throw new Error("server did not start");
    await sleep(100);
  }
  const { code, hostKey } = (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json())) as { code: string; hostKey: string };

  let lastState = "";
  let stateBytes = 0;
  let broadcasts = 0;
  const sockets: WebSocket[] = [];
  const open = (clientId: string, kind: "host" | "player") =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      ws.onopen = () => ws.send(JSON.stringify(join(clientId, code, kind, kind === "host" ? hostKey : undefined)));
      ws.onmessage = (ev) => {
        const raw = String(ev.data);
        if (raw.startsWith('{"type":"WELCOME"')) resolve(ws);
        else if (raw.startsWith('{"type":"PING"')) ws.send('{"type":"PONG"}');
        else if (kind === "host" && raw.startsWith('{"type":"ROOM_STATE"')) {
          lastState = raw;
          stateBytes = Buffer.byteLength(raw);
          broadcasts++;
        }
      };
      sockets.push(ws);
    });
  const host = await open(crypto.randomUUID(), "host");
  await Promise.all(Array.from({ length: N - 1 }, () => open(crypto.randomUUID(), "player")));
  const status = setInterval(() => {
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"CLIENT_STATUS","rttMs":10,"syncErrMs":2,"outputLatencyMs":null,"audioState":"ready"}');
  }, 2000);

  const stalledIds = Array.from({ length: K }, () => crypto.randomUUID());
  const stalled = await Promise.all(stalledIds.map((id) => stalledClient(id, code)));
  await sleep(700);
  const before = await readProcStats(proc.pid);
  const target = stalledIds[0]!;
  const drag = setInterval(() => host.send(JSON.stringify({ type: "SET_POSITION", clientId: target, x: Math.random(), y: Math.random() })), 100);

  const rows: Array<{ tSec: number; rssMb: number; stalledConnected: number; stateBytes: number; broadcasts: number }> = [];
  console.log(`slow-consumer: ${N} ordinary clients + ${K} that never read; room broadcasts at the 2 Hz cap`);
  console.log(`  command: bun apps/server/scripts/slow-consumer.ts ${process.argv.slice(2).join(" ")}`);
  console.log(`  server RSS before the stall: ${((before?.rssKb ?? 0) / 1024).toFixed(0)} MB`);
  console.log(`  t(s)  RSS(MB)  delta(MB)  per stalled socket(MB)  stalled still "connected"  ROOM_STATE(B)  broadcasts`);
  const t0 = performance.now();
  while (performance.now() - t0 < DURATION_SEC * 1000) {
    await sleep(5000);
    const s = await readProcStats(proc.pid);
    const room = lastState ? (JSON.parse(lastState) as { room: { clients: Record<string, { connected: boolean }> } }).room : null;
    const stillConnected = room ? stalledIds.filter((id) => room.clients[id]?.connected).length : -1;
    const rssMb = (s?.rssKb ?? 0) / 1024;
    const delta = rssMb - (before?.rssKb ?? 0) / 1024;
    const row = { tSec: Math.round((performance.now() - t0) / 1000), rssMb, stalledConnected: stillConnected, stateBytes, broadcasts };
    rows.push(row);
    console.log(`  ${String(row.tSec).padStart(4)}  ${rssMb.toFixed(0).padStart(7)}  ${delta.toFixed(0).padStart(9)}  ${(delta / K).toFixed(1).padStart(22)}  ${String(stillConnected).padStart(25)}  ${String(stateBytes).padStart(13)}  ${String(broadcasts).padStart(10)}`);
  }
  clearInterval(drag);
  clearInterval(status);
  const peak = rows.reduce((a, b) => (b.rssMb > a.rssMb ? b : a), rows[0]!);
  const queuedPerSocketMb = (broadcasts * stateBytes) / 1e6;
  console.log(`  peak RSS ${peak.rssMb.toFixed(0)} MB at t=${peak.tSec}s; the room published ~${queuedPerSocketMb.toFixed(0)} MB per socket over the run`);
  const out = args.get("out");
  if (out) await Bun.write(out, JSON.stringify({ clients: N, stalled: K, durationSec: DURATION_SEC, rssBeforeMb: (before?.rssKb ?? 0) / 1024, rows }, null, 2) + "\n");
  for (const s of stalled) s.destroy();
  for (const ws of sockets) ws.close();
  await sleep(200);
} finally {
  proc.kill();
}
process.exit(0);
