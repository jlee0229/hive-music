#!/usr/bin/env bun
// permessage-deflate on Bun's WebSocket server: is it negotiated, what goes on the wire, what does it cost?
//
//   bun apps/server/scripts/ws-compress-probe.ts [--clients 100] [--room 100] [--publishes 40] [--port 8185]
//
// The real server (apps/server/src/index.ts) does not set `perMessageDeflate`, and Bun's default is
// off. This probe starts a minimal Bun.serve in a child process three ways — off / on but publishing
// without the compress flag / on and publishing with it — connects raw TCP clients that ask for the
// extension exactly as a browser does, publishes a realistic ROOM_STATE frame (built by
// room-state-size.ts) and counts the bytes each socket really receives and the CPU the server burns.
// Raw sockets, because a WebSocket client library would hide both the handshake and the wire size.
import net from "node:net";
import { buildRoom } from "./room-state-size";
import { parseArgs } from "./lib/stats";

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.get("port") ?? 8185);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (args.get("role") === "server") {
  const deflate = args.get("deflate") === "1";
  const compressFlag = args.get("compress") === "1";
  const frame = JSON.stringify({ type: "ROOM_STATE", room: buildRoom(Number(args.get("room")), "STROBE", 1) });
  const server = Bun.serve({
    port: PORT,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (url.pathname === "/publish") {
        const count = Number(url.searchParams.get("count"));
        const before = process.cpuUsage();
        let dropped = 0;
        for (let i = 0; i < count; i++) {
          // Vary a few bytes per publish, as real snapshots do, so no layer can reuse a compressed copy.
          const r = srv.publish("room", frame.replace('"code":"BZQ7"', `"code":"B${String(1000 + i).slice(1)}"`), compressFlag);
          if (r === 0) dropped++;
          await sleep(25);
        }
        const used = process.cpuUsage(before);
        return Response.json({ frameBytes: Buffer.byteLength(frame), cpuMs: (used.user + used.system) / 1000, dropped });
      }
      return new Response("ok");
    },
    websocket: {
      perMessageDeflate: deflate,
      open(ws) {
        ws.subscribe("room");
      },
      message() {},
    },
  });
  console.log(`probe server on ${server.port} deflate=${deflate} compress=${compressFlag}`);
  await new Promise(() => {});
}

interface Raw {
  sock: net.Socket;
  extensions: string;
  bytes: number;
}
function rawClient(): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    const state: Raw = { sock, extensions: "", bytes: 0 };
    let head = "";
    let upgraded = false;
    sock.on("error", reject);
    sock.on("connect", () =>
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: localhost:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n\r\n`,
      ),
    );
    sock.on("data", (chunk) => {
      if (upgraded) {
        state.bytes += chunk.length;
        return;
      }
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!head.startsWith("HTTP/1.1 101")) return reject(new Error(head.split("\r\n")[0]));
      state.extensions = head.match(/sec-websocket-extensions:\s*(.*)\r\n/i)?.[1] ?? "(none)";
      state.bytes += Buffer.byteLength(head.slice(end + 4), "latin1");
      upgraded = true;
      resolve(state);
    });
  });
}

const CLIENTS = Number(args.get("clients") ?? 100);
const ROOM = Number(args.get("room") ?? 100);
const PUBLISHES = Number(args.get("publishes") ?? 40);

console.log(`permessage-deflate probe: ${CLIENTS} sockets, a ${ROOM}-client ROOM_STATE, ${PUBLISHES} publishes each`);
console.log(`  command: bun apps/server/scripts/ws-compress-probe.ts ${process.argv.slice(2).join(" ")}`);
const results: unknown[] = [];
for (const [deflate, compress, label] of [
  ["0", "0", "perMessageDeflate off (what production runs)"],
  ["1", "0", "perMessageDeflate on, publish(topic, data)"],
  ["1", "1", "perMessageDeflate on, publish(topic, data, true)"],
] as const) {
  const child = Bun.spawn([process.execPath, import.meta.path, "--role", "server", "--port", String(PORT), "--deflate", deflate, "--compress", compress, "--room", String(ROOM)], { stdout: "ignore", stderr: "inherit" });
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
      } catch {}
      if (i > 100) throw new Error("probe server did not start");
      await sleep(50);
    }
    const clients = await Promise.all(Array.from({ length: CLIENTS }, () => rawClient()));
    await sleep(200);
    const res = (await fetch(`http://localhost:${PORT}/publish?count=${PUBLISHES}`).then((r) => r.json())) as { frameBytes: number; cpuMs: number; dropped: number };
    await sleep(500);
    const perFrame = clients.reduce((a, c) => a + c.bytes, 0) / CLIENTS / PUBLISHES;
    const row = { label, negotiated: clients[0]!.extensions, frameBytes: res.frameBytes, wireBytesPerFrame: Math.round(perFrame), ratio: perFrame / res.frameBytes, cpuMsPerPublish: res.cpuMs / PUBLISHES, dropped: res.dropped };
    results.push(row);
    console.log(`  ${label}`);
    console.log(`    server answered Sec-WebSocket-Extensions: ${row.negotiated}`);
    console.log(`    JSON frame ${row.frameBytes} B -> ${row.wireBytesPerFrame} B on the wire per socket (${(row.ratio * 100).toFixed(1)} %); server CPU ${row.cpuMsPerPublish.toFixed(2)} ms per publish to ${CLIENTS} sockets`);
    for (const c of clients) c.sock.destroy();
  } finally {
    child.kill();
    await child.exited;
  }
}
const out = args.get("out");
if (out) await Bun.write(out, JSON.stringify({ clients: CLIENTS, room: ROOM, publishes: PUBLISHES, results }, null, 2) + "\n");
process.exit(0);
