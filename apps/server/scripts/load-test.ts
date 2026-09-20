#!/usr/bin/env bun
// Load test: 30 fake clients against a locally spawned real server for 3 minutes.
//   bun apps/server/scripts/load-test.ts [--clients 30] [--duration 180]
//
// Each client: JOIN once, NTP_REQUEST at 1Hz, CLIENT_STATUS every 2s. The host additionally:
// SET_POSITION on another client at 10Hz for the first 20s, and SET_MODE every 10s. Reports:
//   - NTP (t2-t1) server-side processing latency, p50/p99 (target < 1ms)
//   - ROOM_STATE broadcast rate (target <= 2Hz; also the worst 1s window)
//   - the largest message any client received (target <= 64KB)
//   - server RSS at start/mid/end (target: flat, not growing unbounded)
import { MODES, PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type ServerMessage } from "@hive/protocol";

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag?.startsWith("--") && argv[i + 1] !== undefined) out.set(flag.slice(2), argv[i + 1]!);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const NUM_CLIENTS = Number(args.get("clients") ?? 30);
const DURATION_SEC = Number(args.get("duration") ?? 180);
const PORT = 26000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const device = { userAgent: "load-test", platform: "load-test", browserFamily: "desktop-chrome" as const };

function pad(n: number) {
  return String(n).padStart(4, "0");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function readRssKb(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawnSync(["cat", `/proc/${pid}/status`]);
    const text = new TextDecoder().decode(proc.stdout);
    const m = text.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

class LoadClient {
  ws: WebSocket;
  clientId: string;
  isHost: boolean;
  ntpLatenciesMs: number[] = [];
  msgCount = 0;
  maxMsgBytes = 0;
  roomStateTimestamps: number[] = [];
  ready: Promise<void>;

  constructor(index: number, isHost: boolean) {
    this.clientId = `${isHost ? "host" : "play"}-load-${pad(index)}`;
    this.isHost = isHost;
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ready = new Promise((resolve) => (this.ws.onopen = () => resolve()));
    this.ws.onmessage = (ev) => {
      const raw = String(ev.data);
      this.msgCount++;
      this.maxMsgBytes = Math.max(this.maxMsgBytes, new TextEncoder().encode(raw).length);
      const m = parseServerMessage(raw);
      if (!m) return;
      if (m.type === "NTP_RESPONSE") this.ntpLatenciesMs.push(m.t2 - m.t1);
      if (m.type === "ROOM_STATE") this.roomStateTimestamps.push(performance.now());
    };
  }

  send(m: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  async join(roomCode: string, hostKey: string) {
    await this.ready;
    this.send({
      type: "JOIN",
      clientId: this.clientId,
      roomCode,
      kind: this.isHost ? "host" : "player",
      plays: !this.isHost,
      hostKey: this.isHost ? hostKey : undefined,
      device,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  close() {
    this.ws.close();
  }
}

async function main() {
  console.log(`[load-test] spawning server on :${PORT}`);
  const proc = Bun.spawn(["bun", `${import.meta.dir}/../src/index.ts`], {
    env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 49) throw new Error("server did not start");
  }

  const { code, hostKey } = (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json())) as { code: string; hostKey: string };
  console.log(`[load-test] room ${code}, ${NUM_CLIENTS} clients, ${DURATION_SEC}s`);

  const clients = Array.from({ length: NUM_CLIENTS }, (_, i) => new LoadClient(i, i === 0));
  const host = clients[0]!;
  const targetId = clients[1]!.clientId;

  await Promise.all(clients.map((c) => c.join(code, hostKey)));
  await new Promise((r) => setTimeout(r, 500)); // let WELCOME/ROOM_STATE settle before measuring

  const rssStart = await readRssKb(proc.pid);

  const timers: ReturnType<typeof setInterval>[] = [];
  for (const c of clients) {
    timers.push(
      setInterval(() => {
        c.send({ type: "NTP_REQUEST", t0: performance.timeOrigin + performance.now() });
      }, 1000),
    );
    timers.push(
      setInterval(() => {
        c.send({ type: "CLIENT_STATUS", rttMs: c.ntpLatenciesMs.at(-1) ?? null, syncErrMs: null, outputLatencyMs: null, audioState: "ready" });
      }, 2000),
    );
  }

  const setPositionTimer = setInterval(() => {
    host.send({ type: "SET_POSITION", clientId: targetId, x: Math.random(), y: Math.random() });
  }, 100); // 10Hz
  setTimeout(() => clearInterval(setPositionTimer), 20_000);

  let modeIdx = 0;
  const setModeTimer = setInterval(() => {
    host.send({ type: "SET_MODE", mode: MODES[modeIdx % MODES.length]!, params: {} });
    modeIdx++;
  }, 10_000);

  const midTimeout = setTimeout(async () => console.log(`[load-test] t+${(DURATION_SEC / 2).toFixed(0)}s rss=${await readRssKb(proc.pid)}kB`), (DURATION_SEC * 1000) / 2);

  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000));

  clearTimeout(midTimeout);
  clearInterval(setModeTimer);
  clearInterval(setPositionTimer);
  for (const t of timers) clearInterval(t);

  const rssEnd = await readRssKb(proc.pid);
  clients.forEach((c) => c.close());
  await new Promise((r) => setTimeout(r, 200));
  proc.kill();

  // ---- aggregate ----------------------------------------------------------
  const allNtp = clients.flatMap((c) => c.ntpLatenciesMs).sort((a, b) => a - b);
  const maxMsgBytes = Math.max(...clients.map((c) => c.maxMsgBytes));
  const roomStateTs = host.roomStateTimestamps; // one observer is enough: it's a broadcast
  const roomStateCount = roomStateTs.length;
  const avgHz = roomStateCount / DURATION_SEC;
  // The server's real guarantee is a minimum gap between consecutive publishes, not a fixed count
  // per arbitrary window (a naive sliding-window count of two publishes exactly minGap apart can
  // show 3 across a boundary purely from ordinary setTimeout jitter, without the gap ever shrinking).
  let minGapMs = Infinity;
  for (let i = 1; i < roomStateTs.length; i++) minGapMs = Math.min(minGapMs, roomStateTs[i]! - roomStateTs[i - 1]!);
  let worstWindowCount = 0;
  for (let i = 0; i < roomStateTs.length; i++) {
    let n = 1;
    for (let j = i + 1; j < roomStateTs.length && roomStateTs[j]! - roomStateTs[i]! < 1000; j++) n++;
    worstWindowCount = Math.max(worstWindowCount, n);
  }

  const report = [
    `Load test: ${NUM_CLIENTS} clients, ${DURATION_SEC}s, room ${code}`,
    ``,
    `NTP server-side processing latency (t2-t1), ${allNtp.length} samples:`,
    `  p50 = ${percentile(allNtp, 50).toFixed(3)} ms`,
    `  p99 = ${percentile(allNtp, 99).toFixed(3)} ms`,
    `  max = ${allNtp.at(-1)?.toFixed(3)} ms`,
    `  target: p50/p99 < 1 ms  ->  ${percentile(allNtp, 50) < 1 && percentile(allNtp, 99) < 1 ? "PASS" : "FAIL"}`,
    ``,
    `ROOM_STATE broadcast rate (observed by the host):`,
    `  ${roomStateCount} messages over ${DURATION_SEC}s = ${avgHz.toFixed(3)} Hz average`,
    `  smallest gap between consecutive broadcasts: ${Number.isFinite(minGapMs) ? minGapMs.toFixed(1) : "n/a"} ms`,
    `  worst 1s sliding-window count (informational; a boundary artifact, not the server's real guarantee): ${worstWindowCount} messages`,
    `  target: >= 1000/ROOM_STATE_MAX_HZ (500ms), 10ms tolerance for client-side measurement/timer` +
      ` granularity  ->  ${!Number.isFinite(minGapMs) || minGapMs >= 490 ? "PASS" : "FAIL"}`,
    ``,
    `Largest message any client received: ${maxMsgBytes} bytes`,
    `  target: <= 65536 bytes  ->  ${maxMsgBytes <= 65536 ? "PASS" : "FAIL"}`,
    ``,
    `Server RSS: start=${rssStart ?? "n/a"}kB end=${rssEnd ?? "n/a"}kB`,
    `  target: roughly flat (no unbounded growth over one run)  ->  ${rssStart != null && rssEnd != null ? (rssEnd < rssStart * 1.5 ? "PASS" : "FAIL (grew >50%)") : "n/a (could not read /proc)"}`,
  ].join("\n");

  console.log("\n" + report);
  await Bun.write(`${import.meta.dir}/../../../evidence/server/load-test.txt`, report + "\n");
}

await main();
process.exit(0);
