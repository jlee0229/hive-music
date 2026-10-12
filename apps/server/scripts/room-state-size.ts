#!/usr/bin/env bun
// Where do the bytes of a ROOM_STATE go, and what would each slimming option save?
//
//   bun apps/server/scripts/room-state-size.ts [--clients 100] [--mode STROBE] [--stems 1] [--out <file.json>]
//
// No server and no sockets: the room is built with the real planner (withAssignments) from the same
// values the real server stores (UUID client ids, blanked userAgent, fractional server times, full
// precision map positions, a finished calibration run), so the sizes are what goes on the wire.
// Everything is seeded: the same flags print the same bytes.
//
// Sections:
//   1. field-by-field breakdown of one snapshot (bytes and %)
//   2. prototypes: (a) drop derivable/duplicate fields, (b) assignments separate from the roster,
//      (c) per-recipient snapshots, (d) JSON deltas, (e) permessage-deflate (raw deflate of the frame)
//   3. egress for one mode change and for a 2 Hz drag at 30 / 100 / 300 phones, today vs each option
//   4. CPU: plan + stringify on the server, JSON.parse + zod validation on a client, deflate
import { deflateRawSync } from "node:zlib";
import {
  IDLE_CALIBRATION, MODES, PROTOCOL_VERSION, ROLE_COLORS, STARTER_LATENCY_TABLE_MS, parseServerMessage, withAssignments,
  type ClientRecord, type ModeKind, type RoomState,
} from "@hive/protocol";
import { parseArgs, rng, seededUuid } from "./lib/stats";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.get("clients") ?? 100);
const MODE = (args.get("mode") ?? "STROBE") as ModeKind;
const STEM_COUNT = Number(args.get("stems") ?? 1);
if (!MODES.includes(MODE)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const pct = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)}%`;
const kb = (b: number) => `${(b / 1000).toFixed(1)} kB`;

const DEVICES = [
  { userAgent: "", platform: "iPhone", browserFamily: "ios-safari" as const },
  { userAgent: "", platform: "Linux armv81", browserFamily: "android-chrome" as const, model: "Pixel 9" },
  { userAgent: "", platform: "Linux armv81", browserFamily: "android-chrome" as const, model: "SM-S921B" },
];

/** A room the way the real server holds it after a calibrated Start: 1 host (not a speaker) + n-1 players. */
export function buildRoom(n: number, mode: ModeKind, stemCount: number, seed = 7): RoomState {
  const rand = rng(seed);
  const t0 = 1760180000000 + rand() * 1e6;
  const clients: Record<string, ClientRecord> = {};
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = seededUuid(rand);
    ids.push(id);
    const device = DEVICES[Math.floor(rand() * DEVICES.length)]!;
    const isHost = i === 0;
    clients[id] = {
      id,
      kind: isHost ? "host" : "player",
      plays: !isHost,
      name: `Phone ${i + 1}`,
      device,
      joinIndex: i,
      joinedAtServerTime: t0 + i * 1234.5678 + rand(),
      // Half the room has been placed on the map (WAVE / STEREO need it); the rest sit unplaced.
      position: rand() < 0.5 ? { x: rand(), y: rand() } : null,
      pinnedRole: null,
      nudgeMs: 0,
      // CLIENT_STATUS with a live outputLatency nulls the table guess; a calibrated phone has an offset.
      tableLatencyMs: rand() < 0.5 ? null : STARTER_LATENCY_TABLE_MS[device.browserFamily],
      calibratedOffsetMs: isHost ? null : 20 + rand() * 60,
      assignment: null,
      connected: true,
      audioReadyTrackId: "aaron-smith-dancin-krono-remix-4-c3b5f44b",
    };
  }
  const players = ids.slice(1);
  const room: RoomState = {
    code: "BZQ7",
    protocolVersion: PROTOCOL_VERSION,
    createdAtServerTime: t0,
    hostClientIds: [ids[0]!],
    track: {
      id: "aaron-smith-dancin-krono-remix-4-c3b5f44b",
      title: "Aaron Smith - Dancin (KRONO Remix)",
      durationSec: 256.3,
      stems: stemCount === 1 ? ["mix"] : ["drums", "bass", "vocals", "other"].slice(0, stemCount),
      bpm: 124,
      beatOffsetSec: 0.2103,
    },
    transport: { state: "playing", serverTimeAtTrackZero: t0 + 60_000.123 },
    mode: { kind: mode, params: mode === "STROBE" ? { groups: 4, beatsPerSwitch: 1 } : {} },
    scenePlan: null,
    // The tuning moment at Start leaves its order and results in every later snapshot.
    calibration: {
      ...IDLE_CALIBRATION,
      state: "done",
      referenceClientId: ids[0]!,
      startServerTime: t0 + 30_000.5,
      order: players,
      results: Object.fromEntries(players.map((id) => [id, { residualMs: Math.round((rand() * 40 - 20) * 100) / 100, confidence: 0.5 + rand() * 0.5 }])),
    },
    clients,
  };
  return withAssignments(room);
}

// ---- 1. breakdown -------------------------------------------------------------------------------------
function breakdown(room: RoomState) {
  const total = bytes({ type: "ROOM_STATE", room });
  const rows = new Map<string, number>();
  const add = (k: string, b: number) => rows.set(k, (rows.get(k) ?? 0) + b);
  const field = (k: string, v: unknown) => Buffer.byteLength(JSON.stringify(k)) + 1 + bytes(v) + 1; // "k":v,
  for (const [k, v] of Object.entries(room)) {
    if (k === "clients") continue;
    if (k === "calibration") {
      const cal = v as RoomState["calibration"];
      add("room.calibration.order (every player id again)", field("order", cal.order));
      add("room.calibration.results (id + residual + confidence)", field("results", cal.results));
      add("room.calibration (state, reference, start)", field(k, v) - field("order", cal.order) - field("results", cal.results));
    } else add(`room.${k}`, field(k, v));
  }
  for (const [id, c] of Object.entries(room.clients)) {
    add("clients{} key (the id, 1st copy)", Buffer.byteLength(JSON.stringify(id)) + 1 + 2 + 1);
    for (const [k, v] of Object.entries(c)) {
      if (k === "assignment" && v) {
        add("client.assignment (key + braces)", 15);
        for (const [ak, av] of Object.entries(v)) add(`client.assignment.${ak}`, field(ak, av));
      } else if (k === "device") {
        add("client.device (key + braces)", 11);
        for (const [dk, dv] of Object.entries(v as object)) add(`client.device.${dk}`, field(dk, dv));
      } else add(`client.${k}`, field(k, v));
    }
  }
  const sorted = [...rows.entries()].sort((a, b) => b[1] - a[1]);
  const accounted = sorted.reduce((a, [, b]) => a + b, 0);
  return { total, sorted, accounted };
}

// ---- 2. prototypes ------------------------------------------------------------------------------------
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** (a) Same information, nothing derivable or duplicated; numbers rounded to what anything can use. */
function slimRecord(c: ClientRecord) {
  const a = c.assignment;
  return {
    // id: the map key. device.userAgent: always "". assignment.color: ROLE_COLORS[role].
    // assignment.compensationMs: nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0), already here.
    kind: c.kind,
    plays: c.plays,
    name: c.name,
    device: { platform: c.device.platform, browserFamily: c.device.browserFamily, ...(c.device.model ? { model: c.device.model } : {}) },
    joinIndex: c.joinIndex,
    joinedAtServerTime: Math.round(c.joinedAtServerTime),
    ...(c.position ? { position: { x: round(c.position.x, 3), y: round(c.position.y, 3) } } : {}),
    ...(c.pinnedRole ? { pinnedRole: c.pinnedRole } : {}),
    ...(c.nudgeMs ? { nudgeMs: c.nudgeMs } : {}),
    ...(c.tableLatencyMs != null ? { tableLatencyMs: c.tableLatencyMs } : {}),
    ...(c.calibratedOffsetMs != null ? { calibratedOffsetMs: round(c.calibratedOffsetMs, 2) } : {}),
    connected: c.connected,
    audioReadyTrackId: c.audioReadyTrackId,
    ...(a ? { assignment: slimAssignment(a) } : {}),
  };
}
function slimAssignment(a: NonNullable<ClientRecord["assignment"]>) {
  if (ROLE_COLORS[a.role] !== a.color) throw new Error("color is not derivable from role — option (a) would lose information");
  return {
    label: a.label,
    role: a.role,
    gainsDb: a.gainsDb,
    ...(a.delayMs ? { delayMs: a.delayMs } : {}),
    ...(a.pattern ? { pattern: a.pattern } : {}),
    ...(a.applyAtServerTime != null ? { applyAtServerTime: a.applyAtServerTime } : {}),
    ...(a.pitchSemitones ? { pitchSemitones: a.pitchSemitones } : {}),
  };
}
function slimRoom(room: RoomState) {
  const { clients, calibration, ...rest } = room;
  return {
    ...rest,
    createdAtServerTime: Math.round(room.createdAtServerTime),
    // order is only needed while a run is in flight; results only by the host UI right after one.
    calibration: calibration.state === "countdown" || calibration.state === "running" ? calibration : { state: calibration.state, referenceClientId: calibration.referenceClientId, startServerTime: calibration.startServerTime, order: [], results: {} },
    clients: Object.fromEntries(Object.entries(clients).map(([id, c]) => [id, slimRecord(c)])),
  };
}

/** Room-level state with no roster: what a player needs besides its own record. */
function roomHeader(room: RoomState) {
  const { clients: _clients, calibration, ...rest } = room;
  // A player needs the calibration *state* (to drop pending clicks on idle), never the order/results.
  return { ...rest, calibration: { state: calibration.state, referenceClientId: calibration.referenceClientId, startServerTime: calibration.startServerTime, order: [], results: {} }, playerCount: Object.values(room.clients).filter((c) => c.plays).length };
}

function sizes(n: number, mode: ModeKind, stemCount: number) {
  const room = buildRoom(n, mode, stemCount);
  const players = Object.values(room.clients).filter((c) => c.kind === "player");
  const hosts = n - players.length;
  const me = players[Math.floor(players.length / 2)] ?? Object.values(room.clients)[0]!;
  const full = bytes({ type: "ROOM_STATE", room });
  const frame = JSON.stringify({ type: "ROOM_STATE", room });

  const slim = bytes({ type: "ROOM_STATE", room: slimRoom(room) });
  // (b) roster without assignments, and the assignments on their own (id -> slim assignment)
  const rosterOnly = bytes({ type: "ROOM_STATE", room: { ...room, clients: Object.fromEntries(Object.entries(room.clients).map(([id, c]) => [id, { ...c, assignment: null }])) } });
  const assignmentsOnly = bytes({ type: "ASSIGNMENTS", mode: room.mode, assignments: Object.fromEntries(Object.entries(room.clients).map(([id, c]) => [id, c.assignment])) });
  // (c) what one player receives: header + its own record (today's record shape, untouched)
  const playerView = bytes({ type: "ROOM_STATE", room: { ...roomHeader(room), clients: { [me.id]: me } } });
  const playerViewSlim = bytes({ type: "ROOM_STATE", room: { ...roomHeader(slimRoom(room) as unknown as RoomState), clients: { [me.id]: slimRecord(me) } } });
  // (d) deltas, as JSON merge patches
  const moved = { ...room.clients[me.id]!, position: { x: 0.123456789012345, y: 0.987654321098765 } };
  const deltaPosition = bytes({ type: "ROOM_PATCH", rev: 1234, clients: { [me.id]: { position: moved.position, assignment: withAssignments({ ...room, clients: { ...room.clients, [me.id]: moved } }).clients[me.id]!.assignment } } });
  const deltaReady = bytes({ type: "ROOM_PATCH", rev: 1234, clients: { [me.id]: { audioReadyTrackId: room.track!.id } } });
  const deltaJoin = bytes({ type: "ROOM_PATCH", rev: 1234, clients: { [me.id]: me } });
  const deltaMode = bytes({ type: "ROOM_PATCH", rev: 1234, mode: room.mode, clients: Object.fromEntries(Object.entries(room.clients).map(([id, c]) => [id, { assignment: c.assignment }])) });
  // ...and the same mode change if a client derives its own assignment from (mode, own record): the
  // planner is a pure function shipped in @hive/protocol, and no mode reads another client's record.
  const deltaModeDerived = bytes({ type: "ROOM_PATCH", rev: 1234, mode: room.mode, applyAtServerTime: null });
  // (e) permessage-deflate == raw deflate of each frame (no context takeover is the conservative case)
  const deflated = deflateRawSync(frame).byteLength;
  const deflatedSlim = deflateRawSync(JSON.stringify({ type: "ROOM_STATE", room: slimRoom(room) })).byteLength;
  const deflatedPlayer = deflateRawSync(JSON.stringify({ type: "ROOM_STATE", room: { ...roomHeader(room), clients: { [me.id]: me } } })).byteLength;

  return { n, hosts, players: players.length, full, slim, rosterOnly, assignmentsOnly, playerView, playerViewSlim, deltaPosition, deltaReady, deltaJoin, deltaMode, deltaModeDerived, deflated, deflatedSlim, deflatedPlayer, frame, room };
}

// ---- 3. egress model ----------------------------------------------------------------------------------
function egress(s: ReturnType<typeof sizes>) {
  const everyone = s.n;
  return {
    // bytes the server writes for ONE mode change
    modeChange: {
      today: everyone * s.full,
      a_slim: everyone * s.slim,
      b_assignmentsOnly: everyone * s.assignmentsOnly,
      c_perRecipient: s.hosts * s.full + s.players * s.playerView,
      c_perRecipient_slim: s.hosts * s.slim + s.players * s.playerViewSlim,
      d_delta: everyone * s.deltaMode,
      d_delta_derived: everyone * s.deltaModeDerived,
      e_deflate: everyone * s.deflated,
      c_plus_e: s.hosts * s.deflated + s.players * s.deflatedPlayer,
    },
    // bytes per second while the host drags one dot (the 2 Hz cap is the only thing bounding it today)
    dragPerSec: {
      today: 2 * everyone * s.full,
      a_slim: 2 * everyone * s.slim,
      // (b) a position moves that phone's WAVE/STEREO assignment: the roster still goes to everyone
      b_split: 2 * everyone * s.rosterOnly,
      // (c) only hosts/viewers see the roster; the dragged phone gets its own small view
      c_perRecipient: 2 * (s.hosts * s.full + 1 * s.playerView),
      c_perRecipient_slim: 2 * (s.hosts * s.slim + 1 * s.playerViewSlim),
      // (d) a delta is small enough to send at the full 10 Hz the host produces
      d_delta_10hz: 10 * everyone * s.deltaPosition,
      e_deflate: 2 * everyone * s.deflated,
      c_plus_d_10hz: 10 * (s.hosts + 1) * s.deltaPosition,
    },
  };
}

// ---- 4. CPU -------------------------------------------------------------------------------------------
function timeIt(label: string, iterations: number, fn: () => void) {
  for (let i = 0; i < Math.min(20, iterations); i++) fn(); // warm up
  const t = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return { label, msPerCall: (performance.now() - t) / iterations };
}

function main() {
  const s = sizes(N, MODE, STEM_COUNT);
  const b = breakdown(s.room);
  const lines: string[] = [];
  const out = (l = "") => lines.push(l);

  out(`ROOM_STATE sizing — ${N} clients (1 host + ${N - 1} players), mode ${MODE}, ${STEM_COUNT} stem(s), calibrated, playing`);
  out(`command: bun apps/server/scripts/room-state-size.ts ${process.argv.slice(2).join(" ")}`);
  out();
  out(`1. Breakdown of one snapshot: ${b.total} bytes = ${(b.total / N).toFixed(0)} bytes per client (accounted: ${b.accounted})`);
  for (const [k, v] of b.sorted) out(`  ${String(v).padStart(7)} B ${pct(v, b.total).padStart(6)}  ${k}`);
  out();
  out(`2. Prototypes at ${N} clients (bytes of one message)`);
  out(`  today, full snapshot to everyone ............ ${s.full}`);
  out(`  (a) derivable/duplicate fields dropped ...... ${s.slim}  (-${pct(s.full - s.slim, s.full)})`);
  out(`  (b) roster without assignments .............. ${s.rosterOnly};  assignments alone ${s.assignmentsOnly}`);
  out(`  (c) one player's view (header + own record) . ${s.playerView}  (slimmed as in (a): ${s.playerViewSlim}); hosts/viewers still get ${s.full}`);
  out(`  (d) delta: one dot moved ${s.deltaPosition}, one AUDIO_READY ${s.deltaReady}, one join ${s.deltaJoin}, mode change ${s.deltaMode} (or ${s.deltaModeDerived} if clients derive their own assignment)`);
  out(`  (e) raw deflate of the frame ................ ${s.deflated}  (-${pct(s.full - s.deflated, s.full)}); of the slim frame ${s.deflatedSlim}; of one player's view ${s.deflatedPlayer}`);
  out();
  out(`3. Server egress, today vs each option`);
  const table: Record<string, unknown> = {};
  for (const n of [30, 100, 300]) {
    const sn = sizes(n, MODE, STEM_COUNT);
    const e = egress(sn);
    table[n] = { sizes: { ...sn, frame: undefined, room: undefined }, egress: e };
    out(`  ${n} clients — one snapshot is ${sn.full} B (${(sn.full / n).toFixed(0)} B/client)`);
    out(`    one mode change: today ${kb(e.modeChange.today)} | (a) ${kb(e.modeChange.a_slim)} | (b) ${kb(e.modeChange.b_assignmentsOnly)} | (c) ${kb(e.modeChange.c_perRecipient)} | (c+a) ${kb(e.modeChange.c_perRecipient_slim)} | (d) ${kb(e.modeChange.d_delta)} / derived ${kb(e.modeChange.d_delta_derived)} | (e) ${kb(e.modeChange.e_deflate)} | (c+e) ${kb(e.modeChange.c_plus_e)}`);
    out(`    host dragging, per second: today ${kb(e.dragPerSec.today)} | (a) ${kb(e.dragPerSec.a_slim)} | (b) ${kb(e.dragPerSec.b_split)} | (c) ${kb(e.dragPerSec.c_perRecipient)} | (c+a) ${kb(e.dragPerSec.c_perRecipient_slim)} | (d @10 Hz) ${kb(e.dragPerSec.d_delta_10hz)} | (e) ${kb(e.dragPerSec.e_deflate)} | (c+d @10 Hz) ${kb(e.dragPerSec.c_plus_d_10hz)}`);
  }
  out();
  out(`4. CPU on this machine, ms per call`);
  const cpu: Array<{ label: string; n: number; msPerCall: number }> = [];
  for (const n of [30, 100, 200, 400]) {
    const sn = sizes(n, MODE, STEM_COUNT);
    const iters = Math.max(20, Math.round(4000 / n));
    const rows = [
      timeIt("server: withAssignments (one replan)", iters, () => void withAssignments(sn.room)),
      timeIt("server: JSON.stringify (one publish)", iters, () => void JSON.stringify({ type: "ROOM_STATE", room: sn.room })),
      timeIt("client: JSON.parse", iters, () => void JSON.parse(sn.frame)),
      timeIt("client: parseServerMessage (JSON.parse + zod)", iters, () => void parseServerMessage(sn.frame)),
      timeIt("server: deflateRaw (zlib default level)", iters, () => void deflateRawSync(sn.frame)),
      timeIt("server: N per-recipient stringifies (option c)", Math.max(5, Math.round(iters / 10)), () => {
        const header = JSON.stringify(roomHeader(sn.room));
        for (const c of Object.values(sn.room.clients)) void `{"type":"ROOM_STATE","room":${header.slice(0, -1)},"clients":{${JSON.stringify(c.id)}:${JSON.stringify(c)}}}}`;
      }),
    ];
    out(`  ${n} clients (${sn.full} B):`);
    for (const r of rows) {
      cpu.push({ ...r, n });
      out(`    ${r.msPerCall.toFixed(3).padStart(8)} ms  ${r.label}`);
    }
  }
  const text = lines.join("\n");
  console.log(text);
  const outPath = args.get("out");
  if (outPath) void Bun.write(outPath, JSON.stringify({ clients: N, mode: MODE, stems: STEM_COUNT, breakdown: { total: b.total, rows: Object.fromEntries(b.sorted) }, table, cpu }, null, 2) + "\n");
}

if (import.meta.main) main();
