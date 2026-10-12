#!/usr/bin/env bun
// Load test: N fake phones against a locally spawned real server (never a remote one — the URL is
// always localhost:<random port in 26000-26899>).
//
//   bun apps/server/scripts/load-test.ts [--clients 30] [--duration 180] [--scenario standard] [--out <basename>]
//
// Every phone behaves like packages/sync-client's real engine on the wire: JOIN, a 20-pair NTP burst
// then one coded pair per second, CLIENT_STATUS every 2 s (with an outputLatencyMs, which is what
// makes the server drop the starter-table guess and replan), PONG to every PING, and the real
// transport's reconnect backoff (300·2^n ms capped at 5 s, no jitter). Client ids are UUIDs, as in the
// browser — they appear several times per record, so short fake ids understate ROOM_STATE by ~20 %.
//
// Scenarios (--scenario):
//   standard         host drags a dot at 10 Hz for the first 20 s and changes mode every --mode-every s
//   idle             no host actions at all (the CPU / egress floor of a quiet room)
//   drag             host drags a dot at 10 Hz for the whole run
//   join-burst       the N phones arrive spread over --join-window seconds (default 5)
//   reconnect-storm  one third in, every socket drops at once and each phone re-JOINs on its backoff
//   restart-storm    one third in, the server process is killed and restarted --restart-gap s later
//                    (a deploy): rooms are in memory, so phones come back to NO_ROOM. Add
//                    --fixed-code ABCD to model the ROOM_FIXED_CODE demo room, which respawns empty.
//   calibrate        SET_TRACK, everyone AUDIO_READY, CALIBRATION_START with the host as reference;
//                    the reference reports --analysis-ms after the last click (default 500)
//   playlist         two "real" tracks of --track-sec declared seconds (default 12) holding --audio-sec
//                    of audio (default 214 s = 18.9 MB): PLAY, wait for the server's auto-advance, every
//                    phone then downloads the next track (--download-bps to throttle each phone, bits/s)
//   soak             standard traffic plus 10 % churn every 15 s; RSS is sampled every 10 s and the
//                    slope reported. Use --duration 600 or more.
//
// Reports (text to stdout and <out>.txt, everything as JSON to <out>.json; default out is
// evidence/server/load-test):
//   - NTP handler latency (t2-t1) and, from a separate canary process probing at 10 Hz, the RTT and
//     clock-offset error a phone would see while the room is busy (= server event-loop lag)
//   - ROOM_STATE rate, size distribution and per-type byte totals; bytes per client per minute
//   - host action -> ROOM_STATE latency to the first / median / last client
//   - server RSS (start / peak / end, slope) and CPU share — on Windows via Get-Process, Linux via /proc
//   - the load generator's own event-loop lag, so a saturated generator is not mistaken for a slow server
import { MODES, PROTOCOL_VERSION, type ClientMessage } from "@hive/protocol";
import { cpuShare, readProcStats, rssSlopeKbPerMin, sampleProc, type ProcStats } from "./lib/proc-stats";
import { fmt, fmtSummary, parseArgs, rng, seededUuid, summarize, type Summary } from "./lib/stats";
import { makeTmpFixtures, type TmpFixtures } from "./lib/tmp-fixtures";

const args = parseArgs(process.argv.slice(2));
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

// ---- canary: a separate process, so its numbers are the server's lag and not this generator's -------
if (args.get("role") === "canary") {
  await runCanary();
  process.exit(0);
}

async function runCanary() {
  const port = Number(args.get("port"));
  const room = args.get("room")!;
  const durationMs = Number(args.get("duration")) * 1000;
  const hz = Number(args.get("hz") ?? 10);
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("canary could not connect"));
  });
  const samples: Array<{ at: number; rtt: number; offset: number }> = [];
  ws.onmessage = (ev) => {
    const t3 = now();
    const raw = String(ev.data);
    if (!raw.startsWith('{"type":"NTP_RESPONSE"')) return;
    const m = JSON.parse(raw) as { t0: number; t1: number; t2: number };
    samples.push({ at: t3, rtt: t3 - m.t0 - (m.t2 - m.t1), offset: (m.t1 - m.t0 + (m.t2 - t3)) / 2 });
  };
  // A viewer: reads the room, is never a speaker and never counted as a player.
  ws.send(
    JSON.stringify({
      type: "JOIN",
      clientId: `canary-${crypto.randomUUID()}`,
      roomCode: room,
      kind: "viewer",
      plays: false,
      device: { userAgent: "", platform: "canary", browserFamily: "other" },
      protocolVersion: PROTOCOL_VERSION,
    } satisfies ClientMessage),
  );
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "NTP_REQUEST", t0: now() }));
  }, 1000 / hz);
  // Runs for --duration, or until the parent closes our stdin (scenarios that end when their work does).
  const startedAt = performance.now();
  await Promise.race([sleep(durationMs), new Promise<void>((r) => process.stdin.once("end", r).once("close", r).resume())]);
  const ranMs = performance.now() - startedAt;
  clearInterval(timer);
  await sleep(200);
  ws.close();
  // Both processes read the same OS clock, so the true offset is a small constant: take it from the
  // quietest decile and report every sample's deviation from it.
  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
  const quiet = byRtt.slice(0, Math.max(1, Math.floor(byRtt.length / 10))).map((s) => s.offset).sort((a, b) => a - b);
  const baseline = quiet[quiet.length >> 1] ?? 0;
  // What a phone's estimator would actually have applied: min-RTT over a sliding window of 30 samples.
  const filtered: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const win = samples.slice(Math.max(0, i - 29), i + 1);
    filtered.push(Math.abs(win.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset - baseline));
  }
  console.log(
    JSON.stringify({
      sent: Math.round((ranMs / 1000) * hz),
      received: samples.length,
      rttMs: summarize(samples.map((s) => s.rtt)),
      rawOffsetErrMs: summarize(samples.map((s) => Math.abs(s.offset - baseline))),
      minRttOf30OffsetErrMs: summarize(filtered),
    }),
  );
}

// ---- configuration ---------------------------------------------------------------------------------
const NUM_CLIENTS = Number(args.get("clients") ?? 30);
const DURATION_SEC = Number(args.get("duration") ?? 180);
const SCENARIO = args.get("scenario") ?? "standard";
const MODE_EVERY_SEC = Number(args.get("mode-every") ?? 10);
const JOIN_WINDOW_SEC = Number(args.get("join-window") ?? 5);
const RESTART_GAP_SEC = Number(args.get("restart-gap") ?? 5);
const FIXED_CODE = args.get("fixed-code") ?? "";
const ANALYSIS_MS = Number(args.get("analysis-ms") ?? 500);
const TRACK_SEC = Number(args.get("track-sec") ?? 12);
const AUDIO_SEC = Number(args.get("audio-sec") ?? 214);
const DOWNLOAD_BPS = Number(args.get("download-bps") ?? 0);
const USE_CANARY = args.get("canary") !== "0";
const OUT_BASE = args.get("out") ?? `${import.meta.dir}/../../../evidence/server/load-test`;
const PORT = 26000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const SCENARIOS = ["standard", "idle", "drag", "join-burst", "reconnect-storm", "restart-storm", "calibrate", "playlist", "soak"];
if (!SCENARIOS.includes(SCENARIO)) throw new Error(`unknown --scenario ${SCENARIO}; one of ${SCENARIOS.join(", ")}`);

const rand = rng(Number(args.get("seed") ?? 42));
/** What real phones send: the server blanks userAgent, keeps platform / browserFamily / model. */
const DEVICES = [
  { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", platform: "iPhone", browserFamily: "ios-safari" as const },
  { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", browserFamily: "android-chrome" as const, model: "Pixel 9" },
  { userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", browserFamily: "android-chrome" as const, model: "SM-S921B" },
];

// ---- shared counters -------------------------------------------------------------------------------
const rxByType = new Map<string, { n: number; bytes: number; max: number }>();
const roomStateSizes: number[] = [];
const ntpHandlerMs: number[] = [];
const ntpRttMs: number[] = [];
const scheduledActionLeadMs: number[] = [];
const errorCodes = new Map<string, number>();
let connectAttempts = 0;
let connectFailures = 0;
let reconnectsCompleted = 0;
let txBytesTotal = 0;
let txMsgsTotal = 0;
let downloadedBytesTotal = 0;

interface Action {
  marker: string;
  sentAt: number;
  latencies: number[];
  expected: number;
}
const actions: Action[] = [];
let currentAction: Action | null = null;

type Hook = (client: LoadClient, type: string, raw: string, at: number) => void;
let onMessageHook: Hook | null = null;

class LoadClient {
  ws: WebSocket | null = null;
  readonly clientId: string;
  readonly device = DEVICES[Math.floor(rand() * DEVICES.length)]!;
  rxBytes = 0;
  rxMsgs = 0;
  maxMsgBytes = 0;
  roomStateAt: number[] = [];
  welcomed = false;
  welcomeAt = 0;
  connectStartedAt = 0;
  joinSentAt = 0;
  firstOwnStateAt = 0;
  lastRoomStateRaw = "";
  private attempt = 0;
  private closedByUser = false;
  private seenAction: Action | null = null;
  private timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  private probeGroup = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly isHost: boolean,
    private roomCode: string,
    private hostKey: string,
  ) {
    this.clientId = seededUuid(rand);
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: ClientMessage) {
    if (!this.open) return;
    const raw = JSON.stringify(m);
    txBytesTotal += raw.length;
    txMsgsTotal++;
    this.ws!.send(raw);
  }

  /** Resolves on WELCOME (or on an ERROR before it, e.g. NO_ROOM — the real client's promise rejects there). */
  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise<void>((resolve) => {
      connectAttempts++;
      this.connectStartedAt = now();
      const sock = new WebSocket(`ws://localhost:${PORT}/ws`);
      this.ws = sock;
      let opened = false;
      sock.onopen = () => {
        opened = true;
        this.joinSentAt = now();
        this.send({
          type: "JOIN",
          clientId: this.clientId,
          roomCode: this.roomCode,
          kind: this.isHost ? "host" : "player",
          plays: !this.isHost,
          hostKey: this.isHost ? this.hostKey : undefined,
          device: this.device,
          protocolVersion: PROTOCOL_VERSION,
        });
      };
      sock.onmessage = (ev) => {
        const at = now();
        const raw = String(ev.data);
        const type = raw.slice(9, raw.indexOf('"', 9));
        this.onRaw(type, raw, at);
        if (type === "WELCOME" || type === "ERROR") resolve();
      };
      sock.onclose = () => {
        if (this.ws !== sock) return;
        this.stopTraffic();
        if (!opened) connectFailures++;
        resolve();
        if (this.closedByUser) return;
        // packages/sync-client/src/transport.ts: attempt++ then 300·2^min(attempt,4), capped at 5 s.
        this.attempt++;
        this.welcomed = false;
        this.reconnectTimer = setTimeout(() => void this.connect(), Math.min(5000, 300 * 2 ** Math.min(this.attempt, 4)));
      };
      sock.onerror = () => {};
    });
  }

  private onRaw(type: string, raw: string, at: number) {
    const bytes = Buffer.byteLength(raw);
    this.rxBytes += bytes;
    this.rxMsgs++;
    if (bytes > this.maxMsgBytes) this.maxMsgBytes = bytes;
    let t = rxByType.get(type);
    if (!t) rxByType.set(type, (t = { n: 0, bytes: 0, max: 0 }));
    t.n++;
    t.bytes += bytes;
    if (bytes > t.max) t.max = bytes;

    switch (type) {
      case "NTP_RESPONSE": {
        const m = JSON.parse(raw) as { t0: number; t1: number; t2: number };
        ntpHandlerMs.push(m.t2 - m.t1);
        ntpRttMs.push(at - m.t0 - (m.t2 - m.t1));
        break;
      }
      case "ROOM_STATE": {
        this.roomStateAt.push(at);
        if (this.isHost) {
          roomStateSizes.push(bytes);
          this.lastRoomStateRaw = raw;
        }
        if (!this.firstOwnStateAt && raw.includes(this.clientId)) this.firstOwnStateAt = at;
        // The mode sits ahead of the client map, so the marker is always in the first couple of KB.
        const a = currentAction;
        // Only phones that were already in the room when the host acted: a later joiner's first snapshot
        // also carries the marker, and would be counted as a seconds-late delivery.
        if (a && this.seenAction !== a && this.welcomeAt < a.sentAt && raw.slice(0, 2000).includes(a.marker)) {
          this.seenAction = a;
          a.latencies.push(at - a.sentAt);
        }
        break;
      }
      case "PING":
        this.send({ type: "PONG" });
        break;
      case "WELCOME":
        if (this.attempt > 0) reconnectsCompleted++;
        this.attempt = 0;
        this.welcomed = true;
        this.welcomeAt = at;
        this.startTraffic();
        break;
      case "ERROR": {
        const code = (JSON.parse(raw) as { code: string }).code;
        errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);
        break;
      }
      case "SCHEDULED_ACTION":
        scheduledActionLeadMs.push((JSON.parse(raw) as { serverTimeToExecute: number }).serverTimeToExecute - at);
        break;
    }
    onMessageHook?.(this, type, raw, at);
  }

  private probe() {
    const id = this.probeGroup++;
    this.send({ type: "NTP_REQUEST", t0: now(), probeGroupId: id, probeGroupIndex: 0 });
    setTimeout(() => this.send({ type: "NTP_REQUEST", t0: now(), probeGroupId: id, probeGroupIndex: 1 }), 10);
  }

  private startTraffic() {
    this.stopTraffic();
    // The engine's schedule: 20 pairs across 4 s, then 1 pair/s; CLIENT_STATUS every 2 s. Phases are
    // whatever the WELCOME instant was, i.e. unsynchronised across phones unless they joined together.
    let n = 0;
    const burst = setInterval(() => {
      this.probe();
      if (++n >= 20) clearInterval(burst);
    }, 200);
    this.timers.push(burst, setInterval(() => this.probe(), 1000));
    this.timers.push(
      setInterval(() => this.send({ type: "CLIENT_STATUS", rttMs: 12, syncErrMs: 3, outputLatencyMs: 24, audioState: "ready" }), 2000),
    );
    this.probe();
  }

  private stopTraffic() {
    for (const t of this.timers) clearInterval(t as ReturnType<typeof setInterval>);
    this.timers = [];
  }

  /** A network drop: the socket dies and the transport's backoff brings it back. */
  drop() {
    this.ws?.close();
  }

  /** The user left: no reconnect. */
  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopTraffic();
    this.ws?.close();
  }

  /** Stream a stem the way the browser engine does (fetch + read to the end), optionally throttled. */
  async download(url: string, bps: number): Promise<{ bytes: number; ms: number; status: number }> {
    const started = performance.now();
    const res = await fetch(url);
    let bytes = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bps > 0) await sleep((bytes * 8 * 1000) / bps - (performance.now() - started));
      }
    }
    downloadedBytesTotal += bytes;
    return { bytes, ms: performance.now() - started, status: res.status };
  }
}

// ---- server process ---------------------------------------------------------------------------------
let fixtures: TmpFixtures | null = null;
function spawnServer() {
  // --server-entry swaps in another entry point (e.g. scripts/proto-per-recipient-server.ts) so a
  // prototype is measured by exactly the same instrument as the real server.
  return Bun.spawn([process.execPath, args.get("server-entry") ?? `${import.meta.dir}/../src/index.ts`], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CORS_ORIGIN: "*",
      ROOM_FIXED_CODE: FIXED_CODE,
      ...(fixtures ? { FIXTURES_DIR: fixtures.dir } : {}),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
}
async function waitHealthy() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not start");
}

async function main() {
  if (SCENARIO === "playlist") fixtures = await makeTmpFixtures({ tracks: 2, trackSec: TRACK_SEC, audioSec: AUDIO_SEC });
  console.log(`[load-test] spawning server on :${PORT} (scenario ${SCENARIO})`);
  let proc = spawnServer();
  const notes: string[] = [];
  const extra: Record<string, unknown> = {};
  try {
    await waitHealthy();
    const { code, hostKey } = (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json())) as { code: string; hostKey: string };
    console.log(`[load-test] room ${code}, ${NUM_CLIENTS} clients, ${DURATION_SEC}s`);

    const procIdle = await readProcStats(proc.pid);
    const clients = Array.from({ length: NUM_CLIENTS }, (_, i) => new LoadClient(i === 0, code, hostKey));
    const host = clients[0]!;
    const players = clients.slice(1);

    // The generator's own event-loop lag: if this is large, the generator is the bottleneck.
    const genLag: number[] = [];
    let lastTick = performance.now();
    const lagTimer = setInterval(() => {
      const t = performance.now();
      genLag.push(Math.max(0, t - lastTick - 20));
      lastTick = t;
    }, 20);

    // ---- join --------------------------------------------------------------------------------------
    const joinStartedAt = now();
    await host.connect();
    if (SCENARIO === "join-burst") {
      const before = await readProcStats(proc.pid);
      const gapMs = (JOIN_WINDOW_SEC * 1000) / Math.max(1, players.length);
      await Promise.all(players.map((c, i) => sleep(i * gapMs).then(() => c.connect())));
      await sleep(1500); // the trailing coalesced snapshot
      const after = await readProcStats(proc.pid);
      const welcome = summarize(players.map((c) => c.welcomeAt - c.connectStartedAt));
      const ownState = summarize(players.filter((c) => c.firstOwnStateAt).map((c) => c.firstOwnStateAt - c.joinSentAt));
      const rx = clients.reduce((a, c) => a + c.rxBytes, 0);
      extra.joinBurst = {
        windowSec: JOIN_WINDOW_SEC,
        connectToWelcomeMs: welcome,
        joinToOwnRoomStateMs: ownState,
        roomStatesSeenByHost: host.roomStateAt.length,
        egressBytesDuringBurst: rx,
        serverCpuMsDuringBurst: before && after ? after.cpuMs - before.cpuMs : null,
      };
      notes.push(
        `Join burst: ${players.length} phones over ${JOIN_WINDOW_SEC}s`,
        `  connect -> WELCOME: ${fmtSummary(welcome)}`,
        `  JOIN -> first ROOM_STATE that contains me: ${fmtSummary(ownState)}`,
        `  ROOM_STATE broadcasts during the burst: ${host.roomStateAt.length}; server egress ${(rx / 1e6).toFixed(2)} MB; server CPU ${before && after ? after.cpuMs - before.cpuMs : "n/a"} ms`,
      );
    } else {
      await Promise.all(players.map((c) => c.connect()));
      await sleep(600);
    }
    const joinedAt = now();
    let procStart = await readProcStats(proc.pid);
    const rxAtStart = clients.reduce((a, c) => a + c.rxBytes, 0);
    const sampler = sampleProc(proc.pid, SCENARIO === "soak" ? 10_000 : 2000);
    const samplers = [sampler];

    const canary = USE_CANARY
      ? Bun.spawn([process.execPath, import.meta.path, "--role", "canary", "--port", String(PORT), "--room", code, "--duration", String(Math.max(DURATION_SEC, 3600))], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
      : null;

    // ---- host behaviour ----------------------------------------------------------------------------
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const target = players[0]?.clientId ?? host.clientId;
    const drag = (forMs: number) => {
      const t = setInterval(() => host.send({ type: "SET_POSITION", clientId: target, x: Math.random(), y: Math.random() }), 100);
      timers.push(t);
      if (Number.isFinite(forMs)) setTimeout(() => clearInterval(t), forMs);
    };
    let modeIdx = 0;
    const changeMode = () => {
      const k = modeIdx++;
      // A unique params pair so each client can tell *this* change's snapshot from any other.
      const params = { spanMs: k % 300, periodMs: 1000 + k };
      const a: Action = { marker: `"params":{"spanMs":${params.spanMs},"periodMs":${params.periodMs}}`, sentAt: now(), latencies: [], expected: clients.filter((c) => c.open).length };
      actions.push(a);
      currentAction = a;
      host.send({ type: "SET_MODE", mode: MODES[k % MODES.length]!, params });
    };
    const modeLoop = () => timers.push(setInterval(changeMode, MODE_EVERY_SEC * 1000));

    if (SCENARIO === "standard" || SCENARIO === "join-burst") {
      drag(20_000);
      modeLoop();
    } else if (SCENARIO === "drag") {
      drag(Infinity);
      modeLoop();
    } else if (SCENARIO === "soak") {
      drag(20_000);
      modeLoop();
      let generation = 0;
      timers.push(
        setInterval(() => {
          // 10 % of the room walks out (no reconnect) and the same number of new phones walk in.
          const leaving = players.splice(0, Math.max(1, Math.floor(players.length / 10)));
          for (const c of leaving) c.close();
          generation++;
          for (let i = 0; i < leaving.length; i++) {
            const c = new LoadClient(false, code, hostKey);
            clients.push(c);
            players.push(c);
            void c.connect();
          }
          extra.churnGenerations = generation;
        }, 15_000),
      );
    } else if (SCENARIO === "reconnect-storm") {
      modeLoop();
      setTimeout(async () => {
        const before = await readProcStats(proc.pid);
        const rxBefore = clients.reduce((a, c) => a + c.rxBytes, 0);
        const statesBefore = host.roomStateAt.length;
        const t0 = now();
        for (const c of clients) c.welcomed = false;
        for (const c of clients) c.drop();
        while (clients.some((c) => !c.welcomed) && now() - t0 < 30_000) await sleep(10);
        const backMs = now() - t0;
        await sleep(1500);
        const after = await readProcStats(proc.pid);
        const rx = clients.reduce((a, c) => a + c.rxBytes, 0) - rxBefore;
        extra.reconnectStorm = { allBackMs: backMs, stillOut: clients.filter((c) => !c.welcomed).length, egressBytes: rx, roomStates: host.roomStateAt.length - statesBefore, serverCpuMs: before && after ? after.cpuMs - before.cpuMs : null };
        notes.push(
          `Reconnect storm: all ${clients.length} sockets dropped at once`,
          `  every phone re-WELCOMEd after ${backMs.toFixed(0)} ms (still out: ${clients.filter((c) => !c.welcomed).length}) — the backoff has no jitter, so they all re-JOIN in the same instant`,
          `  ROOM_STATE broadcasts in the storm window: ${host.roomStateAt.length - statesBefore}; egress ${(rx / 1e6).toFixed(2)} MB; server CPU ${before && after ? after.cpuMs - before.cpuMs : "n/a"} ms`,
        );
      }, (DURATION_SEC * 1000) / 3);
    } else if (SCENARIO === "restart-storm") {
      setTimeout(async () => {
        const attemptsBefore = connectAttempts;
        const noRoomBefore = errorCodes.get("NO_ROOM") ?? 0;
        for (const c of clients) c.welcomed = false;
        const killedAt = now();
        proc.kill();
        await proc.exited;
        await sleep(RESTART_GAP_SEC * 1000);
        const attemptsWhileDown = connectAttempts - attemptsBefore;
        proc = spawnServer();
        await waitHealthy();
        const upAt = now();
        samplers.push(sampleProc(proc.pid, 2000));
        const settled = () => (FIXED_CODE ? clients.every((c) => c.welcomed) : (errorCodes.get("NO_ROOM") ?? 0) - noRoomBefore >= clients.length);
        while (!settled() && now() - upAt < 30_000) await sleep(10);
        const settledMs = now() - upAt;
        await sleep(1500);
        const summary = FIXED_CODE ? (JSON.parse(host.lastRoomStateRaw || "{}") as { room?: { track: unknown; transport: { state: string }; hostClientIds: string[] } }).room : undefined;
        extra.restartStorm = {
          downSec: (upAt - killedAt) / 1000,
          connectAttemptsWhileDown: attemptsWhileDown,
          attemptsPerSecWhileDown: attemptsWhileDown / ((upAt - killedAt) / 1000),
          settledMsAfterUp: settledMs,
          noRoomErrors: (errorCodes.get("NO_ROOM") ?? 0) - noRoomBefore,
          rewelcomed: clients.filter((c) => c.welcomed).length,
          roomAfter: summary ? { track: summary.track, transport: summary.transport.state, hosts: summary.hostClientIds.length } : null,
        };
        notes.push(
          `Restart storm: server killed, back ${((upAt - killedAt) / 1000).toFixed(1)} s later`,
          `  connect attempts while it was down: ${attemptsWhileDown} (${(attemptsWhileDown / ((upAt - killedAt) / 1000)).toFixed(1)}/s from ${clients.length} phones)`,
          FIXED_CODE
            ? `  fixed-code room respawned: ${clients.filter((c) => c.welcomed).length}/${clients.length} re-WELCOMEd within ${settledMs.toFixed(0)} ms; track=${JSON.stringify(summary?.track ?? null)} transport=${summary?.transport.state} hosts=${summary?.hostClientIds.length}`
            : `  ${(errorCodes.get("NO_ROOM") ?? 0) - noRoomBefore}/${clients.length} phones got ERROR NO_ROOM within ${settledMs.toFixed(0)} ms of the server coming back; the server leaves those sockets open and nothing ever re-creates the room`,
        );
      }, (DURATION_SEC * 1000) / 3);
    } else if (SCENARIO === "calibrate") {
      const { tracks } = (await fetch(`${BASE}/tracks`).then((r) => r.json())) as { tracks: Array<{ id: string }> };
      const trackId = tracks[0]!.id;
      host.send({ type: "SET_TRACK", trackId });
      await sleep(700);
      for (const c of players) c.send({ type: "AUDIO_READY", trackId });
      await sleep(1200);
      let startedAt = 0;
      let reportBytes = 0;
      let planBytes = 0;
      let finalState = "none";
      let finishedAt = 0;
      onMessageHook = (c, type, raw, at) => {
        if (c !== host) return;
        if (type === "CALIBRATION_PLAN") {
          planBytes = Buffer.byteLength(raw);
          const plan = JSON.parse(raw) as { startServerTime: number; intervalMs: number; order: string[] };
          // reference.ts: record until start + N·interval + RECORD_TAIL_MS (400), analyse, then report.
          const reportAt = plan.startServerTime + plan.order.length * plan.intervalMs + 400 + ANALYSIS_MS;
          setTimeout(() => {
            const msg: ClientMessage = { type: "CALIBRATION_REPORT", measurements: plan.order.map((clientId) => ({ clientId, residualMs: Math.round((Math.random() * 40 - 20) * 100) / 100, confidence: 0.9 })) };
            reportBytes = JSON.stringify(msg).length;
            host.send(msg);
          }, reportAt - now());
        }
        if (type === "ROOM_STATE" && startedAt && !finishedAt) {
          const m = raw.match(/"calibration":\{"state":"(\w+)"/);
          if (m && (m[1] === "done" || m[1] === "failed")) {
            finalState = m[1];
            finishedAt = at;
          }
        }
      };
      startedAt = now();
      host.send({ type: "CALIBRATION_START", referenceClientId: host.clientId });
      const budgetMs = 3000 + players.length * 400 + 5000 + 3000;
      while (!finishedAt && now() - startedAt < budgetMs) await sleep(50);
      const lead = summarize(scheduledActionLeadMs);
      extra.calibration = { phones: players.length, finalState, totalMs: finishedAt ? finishedAt - startedAt : null, scheduleMs: 3000 + players.length * 400, analysisMs: ANALYSIS_MS, planBytes, reportBytes, scheduledActionLeadMs: lead, scheduledActionsDelivered: scheduledActionLeadMs.length };
      notes.push(
        `Calibration of ${players.length} phones: ${finalState} after ${finishedAt ? ((finishedAt - startedAt) / 1000).toFixed(1) : "n/a"} s`,
        `  schedule = 3 s countdown + ${players.length} x 400 ms = ${((3000 + players.length * 400) / 1000).toFixed(1)} s of clicks; the server fails the run 5 s after the last slot (analysis here took ${ANALYSIS_MS} ms + 400 ms record tail)`,
        `  SCHEDULED_ACTION delivered to ${scheduledActionLeadMs.length}/${players.length}; lead before its click: min=${fmt(lead.min, 0)} p50=${fmt(lead.p50, 0)} ms`,
        `  CALIBRATION_PLAN ${planBytes} B, CALIBRATION_REPORT ${reportBytes} B`,
      );
    } else if (SCENARIO === "playlist") {
      const [first, second] = fixtures!.trackIds as [string, string];
      host.send({ type: "SET_TRACK", trackId: first });
      await sleep(700);
      for (const c of players) c.send({ type: "AUDIO_READY", trackId: first });
      const marker = `"track":{"id":"${second}"`;
      const started = new Set<LoadClient>();
      const readyMs: number[] = [];
      const statuses = new Map<number, number>();
      let advanceSeenAt = 0;
      let trackZero = 0;
      let statesAfterAdvance = 0;
      let peak: ProcStats | null = null;
      const peakTimer = setInterval(async () => {
        const s = await readProcStats(proc.pid);
        if (s && (!peak || s.rssKb > peak.rssKb)) peak = s;
      }, 500);
      onMessageHook = (c, type, raw, at) => {
        if (type !== "ROOM_STATE") return;
        if (c === host && advanceSeenAt) statesAfterAdvance++;
        if (started.has(c) || c === host || !raw.slice(0, 2000).includes(marker)) return;
        started.add(c);
        if (!advanceSeenAt) {
          advanceSeenAt = at;
          trackZero = Number(raw.match(/"serverTimeAtTrackZero":([\d.]+)/)?.[1] ?? 0);
        }
        void c.download(`${BASE}/audio/${second}/mix.wav`, DOWNLOAD_BPS).then((d) => {
          statuses.set(d.status, (statuses.get(d.status) ?? 0) + 1);
          readyMs.push(now() - at);
          c.send({ type: "AUDIO_READY", trackId: second });
        });
      };
      const cpuBefore = await readProcStats(proc.pid);
      host.send({ type: "TRANSPORT", action: "PLAY" });
      const deadline = now() + DURATION_SEC * 1000;
      while (readyMs.length < players.length && now() < deadline) await sleep(100);
      await sleep(1200);
      clearInterval(peakTimer);
      const cpuAfter = await readProcStats(proc.pid);
      const leadMs = trackZero - advanceSeenAt;
      const ready = summarize(readyMs);
      extra.playlist = {
        wavBytes: fixtures!.wavBytes,
        phones: players.length,
        downloadBps: DOWNLOAD_BPS,
        leadMs,
        finished: readyMs.length,
        readyBeforeDownbeat: readyMs.filter((m) => m <= leadMs).length,
        timeToDownloadedMs: ready,
        httpStatuses: Object.fromEntries(statuses),
        downloadedBytes: downloadedBytesTotal,
        serverPeakRssKb: (peak as ProcStats | null)?.rssKb ?? null,
        serverCpuMs: cpuBefore && cpuAfter ? cpuAfter.cpuMs - cpuBefore.cpuMs : null,
        roomStatesAfterAdvance: statesAfterAdvance,
      };
      notes.push(
        `Playlist advance: ${players.length} phones each fetch the next track (${(fixtures!.wavBytes / 1e6).toFixed(1)} MB${DOWNLOAD_BPS ? `, throttled to ${(DOWNLOAD_BPS / 1e6).toFixed(1)} Mbit/s each` : ", unthrottled loopback"})`,
        `  the server gave ${leadMs.toFixed(0)} ms between announcing the track and its downbeat`,
        `  downloaded by ${readyMs.length}/${players.length}; in time for the downbeat: ${readyMs.filter((m) => m <= leadMs).length}; time to downloaded: ${fmtSummary(ready, "ms", 0)}`,
        `  served ${(downloadedBytesTotal / 1e6).toFixed(0)} MB; server peak RSS ${(((peak as ProcStats | null)?.rssKb ?? 0) / 1024).toFixed(0)} MB; server CPU ${cpuBefore && cpuAfter ? cpuAfter.cpuMs - cpuBefore.cpuMs : "n/a"} ms; ROOM_STATE broadcasts after the advance: ${statesAfterAdvance}`,
      );
    }

    if (SCENARIO !== "calibrate" && SCENARIO !== "playlist") await sleep(DURATION_SEC * 1000);

    // ---- wind down ---------------------------------------------------------------------------------
    for (const t of timers) clearInterval(t);
    clearInterval(lagTimer);
    const measuredSec = (now() - joinedAt) / 1000;
    const rxAtEnd = clients.reduce((a, c) => a + c.rxBytes, 0);
    const procSamples = (await Promise.all(samplers.map((s) => s.stop()))).at(-1)!;
    const procEnd = procSamples.at(-1) ?? null;
    let canaryOut: { sent: number; received: number; rttMs: Summary; rawOffsetErrMs: Summary; minRttOf30OffsetErrMs: Summary } | null = null;
    if (canary) {
      canary.stdin.end(); // "stop now and print"
      const text = await Promise.race([new Response(canary.stdout).text(), sleep(5000).then(() => "")]);
      if (!text) canary.kill();
      try {
        canaryOut = JSON.parse(text.trim().split("\n").at(-1) ?? "");
      } catch {
        canaryOut = null;
      }
    }
    for (const c of clients) c.close();
    await sleep(200);

    // ---- aggregate ---------------------------------------------------------------------------------
    const handler = summarize(ntpHandlerMs);
    const rtt = summarize(ntpRttMs);
    const maxMsgBytes = Math.max(...clients.map((c) => c.maxMsgBytes));
    const ts = host.roomStateAt;
    let minGapMs = Infinity;
    for (let i = 1; i < ts.length; i++) minGapMs = Math.min(minGapMs, ts[i]! - ts[i - 1]!);
    const stateSize = summarize(roomStateSizes);
    const done = actions.filter((a) => a.latencies.length > 0);
    const firstMs = summarize(done.map((a) => Math.min(...a.latencies)));
    const lastMs = summarize(done.map((a) => Math.max(...a.latencies)));
    const allMs = summarize(done.flatMap((a) => a.latencies));
    const missed = actions.reduce((n, a) => n + Math.max(0, a.expected - a.latencies.length), 0);
    const egress = rxAtEnd - rxAtStart;
    const live = clients.filter((c) => c.rxMsgs > 0).length;
    const perClientPerMin = egress / Math.max(1, live) / (measuredSec / 60);
    // A restarted server is a different process: CPU since "after join" is meaningless across the two.
    if (SCENARIO === "restart-storm") procStart = null;
    const cpu = procStart && procEnd ? cpuShare(procStart, procEnd) : NaN;
    const peakRss = Math.max(...procSamples.map((s) => s.rssKb), procStart?.rssKb ?? 0);
    const slope = rssSlopeKbPerMin(procSamples);
    const lag = summarize(genLag);
    const types = [...rxByType.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    const totalTyped = types.reduce((a, [, t]) => a + t.bytes, 0);

    const report = [
      `Load test: ${NUM_CLIENTS} clients, ${DURATION_SEC}s, scenario ${SCENARIO}, room ${code}`,
      `  command: bun apps/server/scripts/load-test.ts ${process.argv.slice(2).join(" ")}`,
      ``,
      `NTP handler latency on the server (t2-t1): ${fmtSummary(handler, "ms", 3)}`,
      `  target: p50/p99 < 1 ms  ->  ${handler.p50 < 1 && handler.p99 < 1 ? "PASS" : "FAIL"}`,
      `NTP round trip seen by the load clients (loopback, includes this generator's lag): ${fmtSummary(rtt, "ms", 2)}`,
      canaryOut
        ? [
            `Canary (separate process, 10 Hz, ${canaryOut.received}/${canaryOut.sent} answered) — server event-loop lag as a phone sees it:`,
            `  round trip:                         ${fmtSummary(canaryOut.rttMs, "ms", 2)}`,
            `  clock-offset error, single probe:   ${fmtSummary(canaryOut.rawOffsetErrMs, "ms", 2)}`,
            `  clock-offset error, min-RTT of 30:  ${fmtSummary(canaryOut.minRttOf30OffsetErrMs, "ms", 2)}`,
          ].join("\n")
        : `Canary: n/a`,
      ``,
      `ROOM_STATE (observed by the host): ${ts.length} broadcasts over ${measuredSec.toFixed(0)}s = ${(ts.length / measuredSec).toFixed(3)} Hz`,
      `  smallest gap between consecutive broadcasts: ${Number.isFinite(minGapMs) ? minGapMs.toFixed(1) : "n/a"} ms`,
      `  target: >= 490 ms (the 2 Hz cap, 10 ms tolerance)  ->  ${!Number.isFinite(minGapMs) || minGapMs >= 490 ? "PASS" : "FAIL"}`,
      `  size: ${fmtSummary(stateSize, "bytes", 0)}  = ${fmt(stateSize.max / NUM_CLIENTS, 0)} bytes per client at the max`,
      `Largest message any client received: ${maxMsgBytes} bytes`,
      `  target: <= 65536 bytes  ->  ${maxMsgBytes <= 65536 ? "PASS" : "FAIL"}`,
      ``,
      `Server egress over WebSocket: ${(egress / 1e6).toFixed(2)} MB in ${measuredSec.toFixed(0)}s = ${(egress / measuredSec / 1000).toFixed(1)} kB/s total, ${(perClientPerMin / 1000).toFixed(1)} kB per client per minute`,
      ...types.map(([type, t]) => `  ${type.padEnd(17)} ${String(t.n).padStart(8)} msgs ${(t.bytes / 1e6).toFixed(3).padStart(10)} MB ${((100 * t.bytes) / totalTyped).toFixed(1).padStart(5)} %   largest ${t.max} B`),
      `Client -> server: ${txMsgsTotal} msgs, ${(txBytesTotal / 1e6).toFixed(2)} MB`,
      ``,
      `Host action (SET_MODE) -> the resulting ROOM_STATE, ${done.length} actions:`,
      `  first client: ${fmtSummary(firstMs)}`,
      `  last client:  ${fmtSummary(lastMs)}`,
      `  all clients:  ${fmtSummary(allMs)}   (clients that never saw their snapshot: ${missed})`,
      ``,
      `Server process: RSS idle=${procIdle?.rssKb ?? "n/a"} kB, after join=${procStart?.rssKb ?? "n/a"} kB, peak=${peakRss} kB, end=${procEnd?.rssKb ?? "n/a"} kB` + (procEnd?.privateKb != null ? ` (private ${procEnd.privateKb} kB)` : ``),
      `  RSS slope over the run: ${fmt(slope, 1)} kB/min over ${procSamples.length} samples`,
      `  target: roughly flat (end < 1.5 x after-join)  ->  ${procStart && procEnd ? (procEnd.rssKb < procStart.rssKb * 1.5 ? "PASS" : "FAIL (grew >50%)") : "n/a (could not read process stats)"}`,
      `  CPU: ${procStart && procEnd ? `${(procEnd.cpuMs - procStart.cpuMs).toFixed(0)} ms over ${measuredSec.toFixed(0)}s = ${(cpu * 100).toFixed(2)} % of one core` : "n/a"}` + (ts.length ? `  (${procStart && procEnd ? ((procEnd.cpuMs - procStart.cpuMs) / ts.length).toFixed(2) : "n/a"} ms per ROOM_STATE broadcast, all work included)` : ``),
      `Connections: ${connectAttempts} attempts, ${connectFailures} failed, ${reconnectsCompleted} reconnects completed; errors: ${[...errorCodes].map(([k, v]) => `${k}x${v}`).join(", ") || "none"}`,
      `Load generator event-loop lag: ${fmtSummary(lag, "ms", 1)}${lag.p99 > 50 ? "   <-- generator saturated: treat latencies above as upper bounds" : ""}`,
      ...(notes.length ? ["", ...notes] : []),
    ].join("\n");

    console.log("\n" + report);
    await Bun.write(`${OUT_BASE}.txt`, report + "\n");
    await Bun.write(
      `${OUT_BASE}.json`,
      JSON.stringify(
        {
          clients: NUM_CLIENTS,
          durationSec: DURATION_SEC,
          scenario: SCENARIO,
          measuredSec,
          ntpHandlerMs: handler,
          ntpRttMs: rtt,
          canary: canaryOut,
          roomState: { count: ts.length, minGapMs: Number.isFinite(minGapMs) ? minGapMs : null, sizeBytes: stateSize },
          maxMsgBytes,
          egressBytes: egress,
          egressBytesPerSec: egress / measuredSec,
          egressBytesPerClientPerMin: perClientPerMin,
          rxByType: Object.fromEntries(rxByType),
          tx: { msgs: txMsgsTotal, bytes: txBytesTotal },
          actionLatencyMs: { actions: done.length, first: firstMs, last: lastMs, all: allMs, missed },
          server: { rssIdleKb: procIdle?.rssKb ?? null, rssAfterJoinKb: procStart?.rssKb ?? null, rssPeakKb: peakRss, rssEndKb: procEnd?.rssKb ?? null, rssSlopeKbPerMin: slope, cpuMs: procStart && procEnd ? procEnd.cpuMs - procStart.cpuMs : null, cpuShare: cpu },
          connections: { attempts: connectAttempts, failures: connectFailures, reconnects: reconnectsCompleted, errors: Object.fromEntries(errorCodes) },
          generatorLagMs: lag,
          joinMs: joinedAt - joinStartedAt,
          ...extra,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    proc.kill();
    await fixtures?.cleanup().catch(() => {});
  }
}

await main();
process.exit(0);
