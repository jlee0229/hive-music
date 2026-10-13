import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  DISCONNECT_RETENTION_MS,
  MODES,
  PROTOCOL_VERSION,
  ROOM_IDLE_TTL_MS,
  ROOM_STATE_MAX_HZ,
  RoomStateSchema,
  STEMS,
  parseServerMessage,
  trackTimeSec,
  type RoomState,
  type ScenePlan,
} from "@hive/protocol";
import { MAX_ROOMS, MAX_ROOM_CLIENTS, ROOM_UNCLAIMED_TTL_MS, RoomManager, type Conn, type Room } from "../rooms";
import type { LibraryEntry } from "../library";

/**
 * Audit SG-13: a stateful fuzz of the room server. Several fake sockets — hosts with the key,
 * guests, viewers, impostors reusing other clients' ids, duplicate tabs — drive a RoomManager with
 * long random sequences of valid messages, invalid messages, raw garbage, closes, REST-level calls
 * and jumps of (fake) time, so every timer in the room fires in the middle of everything else.
 *
 * After EVERY step:
 *   - nothing threw;
 *   - each room's state survives a JSON round trip through RoomStateSchema (what phones parse);
 *   - every speaker has an assignment and every non-speaker has none;
 *   - hostClientIds is exactly the set of host records, and viewers never play;
 *   - a record is `connected` exactly when a live socket is registered for it;
 *   - everything the server sent or published parses as a ServerMessage;
 *   - ROOM_STATE is per recipient: a player is sent its own record and nobody else's id, hosts,
 *     viewers and observers the whole roster; no socket gets two closer than the 2 Hz cap; and
 *     whenever the room has nothing left to flush, every open socket holds the current state;
 *   - a message from a socket that never presented the hostKey changed no host-only state, and
 *     every host-only message it sent was answered NOT_HOST;
 *   - every id in hostClientIds got there through a JOIN that carried that room's hostKey — never
 *     through a client id alone, and never because the room had no host at the time.
 * And at the end: with every socket closed, every room is collected and no timer is left behind.
 *
 * Reproduce a failure with the seed and step it prints.
 */
type WS = Bun.ServerWebSocket<Conn>;

function prng(seed: number) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

const LIBRARY: LibraryEntry[] = [
  { id: "short", title: "Short", durationSec: 3, stems: ["mix"], bpm: 120, beatOffsetSec: 0.1 },
  { id: "medium", title: "Medium", durationSec: 20, stems: ["mix"] },
  { id: "stems", title: "Stems", durationSec: 9, stems: [...STEMS], bpm: 96.5 },
  { id: "synth", title: "Synthetic", durationSec: 60, stems: [...STEMS], bpm: 120, generated: true },
];
const FAMILIES = ["ios-safari", "android-chrome", "desktop-chrome", "desktop-safari", "other"] as const;

interface Sock {
  ws: WS;
  open: boolean;
  pendingClose: boolean;
  /** Model of what this socket is, derived from what it sent — never from what the server says. */
  privileged: boolean;
  clientId: string | null;
  room: string | null;
  welcomes: Array<{ isHost: boolean }>;
  errors: string[];
  /** The last ROOM_STATE this socket was sent (its `room`, as JSON) and when. */
  lastState: string | null;
  lastStateAt: number;
  /** The JOIN this socket sent and has not had an answer to yet (it may be held: SG-15). */
  pendingJoin: { clientId: string; code: string; keyOk: boolean } | null;
}

const HOST_ONLY_TYPES = new Set(["SET_TRACK", "TRANSPORT", "SET_MODE", "ASSIGN", "SET_POSITION", "KICK", "CALIBRATION_START", "CALIBRATION_CANCEL", "CALIBRATION_RESET"]);

/** What the run actually exercised — asserted at the end, so the fuzz cannot quietly stop reaching things. */
const coverage = {
  hostWelcomes: 0,
  guestWelcomes: 0,
  observers: 0,
  refusedJoins: 0,
  duplicateTabs: 0,
  serverHangups: 0,
  restoredRooms: 0,
  heldJoinsAdmitted: 0,
  notHostAnswers: 0,
  collectedRooms: 0,
  playlistAdvances: 0,
  sceneModeSwitches: 0,
  calibrationsDone: 0,
  calibrationsFailed: 0,
  kicks: 0,
  pausedRooms: 0,
};

function runSeed(seed: number, steps: number) {
  const r = prng(seed);
  const wallNow = () => performance.timeOrigin + performance.now();
  const minStateGapMs = 1000 / ROOM_STATE_MAX_HZ;
  let lastWire: string | null = null;

  const mgr = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: "fuzz-secret-fuzz-secret-fuzz-secret-0123" });
  mgr.attachServer({
    publish: (topic: string, data: string) => {
      const msg = parseServerMessage(data);
      if (!msg) throw new Error(`published an unparsable message: ${data.slice(0, 300)}`);
      if (msg.type === "ROOM_STATE") throw new Error(`ROOM_STATE published to the whole topic ${topic}: it must be built per recipient`);
    },
  } as unknown as Bun.Server<Conn>);
  const setLibrary = (lib: LibraryEntry[]) => void ((mgr as unknown as { library: LibraryEntry[] }).library = lib);
  setLibrary(LIBRARY);
  const roomsOf = () => (mgr as unknown as { rooms: Map<string, Room> }).rooms;

  const keys = new Map<string, string>(); // code → hostKey, as the legitimate hosts know them
  /** code → client ids that have JOINed that room with its hostKey. Nobody else may ever be a host. */
  const keyed = new Map<string, Set<string>>();
  const socks: Sock[] = [];
  const knownIds: string[] = [];

  const newRoom = () => {
    const res = mgr.createRoom();
    if ("error" in res) return;
    keys.set(res.code, res.hostKey);
  };
  // Each run starts as a server that has just restarted: two rooms existed in the previous process,
  // their hosts still hold the keys, and nobody is connected yet.
  const previous = new RoomManager({ fixturesDir: "/nonexistent", hostKeySecret: "fuzz-secret-fuzz-secret-fuzz-secret-0123" });
  previous.attachServer({ publish: () => {} } as unknown as Bun.Server<Conn>);
  for (let i = 0; i < 2; i++) {
    const res = previous.createRoom();
    if ("error" in res) throw new Error(res.error);
    keys.set(res.code, res.hostKey);
    previous.get(res.code)!.destroy();
  }

  function openSock(): Sock {
    const s: Sock = { ws: null as unknown as WS, open: true, pendingClose: false, privileged: false, clientId: null, room: null, welcomes: [], errors: [], pendingJoin: null, lastState: null, lastStateAt: -Infinity };
    s.ws = {
      data: { clientId: null, roomCode: null },
      send: (raw: string) => {
        const msg = parseServerMessage(raw);
        if (!msg) throw new Error(`sent an unparsable message: ${raw.slice(0, 300)}`);
        if (msg.type === "ERROR") s.errors.push(msg.code);
        if (msg.type === "ROOM_STATE") {
          const t = wallNow();
          const serverId = s.ws.data.clientId; // null: an observer
          const live = s.ws.data.roomCode ? mgr.get(s.ws.data.roomCode) : undefined;
          const rec = serverId && live ? live.room.clients[serverId] : undefined;
          const ids = Object.keys(msg.room.clients);
          if (rec?.kind === "player") {
            if (ids.length !== 1 || ids[0] !== serverId) throw new Error(`player ${serverId} was sent the records of ${JSON.stringify(ids)}`);
            if (msg.room.hostClientIds.length !== 0) throw new Error(`player ${serverId} was sent hostClientIds`);
            const foreign = [...msg.room.calibration.order, ...Object.keys(msg.room.calibration.results), msg.room.calibration.referenceClientId ?? ""].filter((id) => id !== "" && id !== serverId);
            if (foreign.length > 0) throw new Error(`player ${serverId} was sent other clients' ids in the calibration block: ${JSON.stringify(foreign)}`);
            if (live && msg.room.calibration.order.length !== (msg.room.calibration.state === "countdown" || msg.room.calibration.state === "running" ? live.room.calibration.order.length : 0)) {
              throw new Error(`player ${serverId}: calibration order has ${msg.room.calibration.order.length} slots, the room has ${live.room.calibration.order.length}`);
            }
          } else if (live && ids.length !== Object.keys(live.room.clients).length) {
            throw new Error(`a ${rec?.kind ?? "observer"} was sent ${ids.length} of ${Object.keys(live.room.clients).length} records`);
          }
          // (an observer's first snapshot is sent on the spot, outside the coalescing window)
          if (serverId !== null && t - s.lastStateAt < minStateGapMs - 0.001) throw new Error(`${serverId} was sent two ROOM_STATEs ${t - s.lastStateAt} ms apart`);
          s.lastState = JSON.stringify((JSON.parse(raw) as { room: unknown }).room); // as sent, not as zod re-ordered it
          s.lastStateAt = t;
        }
        if (msg.type === "WELCOME") {
          // The model is settled here, when the answer arrives — a held JOIN is answered steps later.
          s.welcomes.push({ isHost: msg.isHost });
          const j = s.pendingJoin;
          if (!j) throw new Error("WELCOME for a socket that had no JOIN outstanding");
          s.pendingJoin = null;
          if (msg.isHost !== j.keyOk) throw new Error(`WELCOME.isHost=${msg.isHost} for a JOIN whose key was ${j.keyOk ? "right" : "absent/wrong"}`);
          const rec = mgr.get(j.code)?.room.clients[j.clientId];
          s.room = j.code;
          s.privileged = j.keyOk;
          // without the key, a record that is a host's can only mean "observer": no identity at all
          s.clientId = !j.keyOk && rec?.kind === "host" ? null : j.clientId;
          if (j.keyOk) keyed.set(j.code, (keyed.get(j.code) ?? new Set()).add(j.clientId));
        }
      },
      subscribe: () => {},
      close: () => void (s.pendingClose = true), // Bun delivers the close event later, not inside close()
    } as unknown as WS;
    socks.push(s);
    return s;
  }
  const deliverCloses = () => {
    for (const s of socks) {
      if (s.pendingClose && s.open) {
        s.open = false;
        mgr.handleClose(s.ws);
      }
    }
  };

  const someId = (room: Room | undefined): string => {
    const ids = room ? Object.keys(room.room.clients) : [];
    if (ids.length > 0 && r.chance(0.8)) return r.pick(ids);
    if (knownIds.length > 0 && r.chance(0.5)) return r.pick(knownIds);
    return `nobody-${r.int(1000).toString().padStart(6, "0")}`;
  };
  const someCode = (): string => {
    const codes = [...keys.keys()];
    if (r.chance(0.06)) return "ZZZZ";
    const code = r.pick(codes);
    return r.chance(0.1) ? code.toLowerCase() : code;
  };

  function joinMessage(): { raw: string; clientId: string; kind: string; code: string; hostKey?: string } {
    const code = someCode();
    const room = mgr.get(code);
    const kind = r.pick(["host", "host", "player", "player", "player", "viewer"] as const);
    let clientId: string;
    if (room && Object.keys(room.room.clients).length > 0 && r.chance(0.35)) clientId = r.pick(Object.keys(room.room.clients)); // reconnect, second tab, or impostor
    else if (knownIds.length > 0 && r.chance(0.2)) clientId = r.pick(knownIds);
    else clientId = `client-${seed}-${knownIds.length.toString().padStart(5, "0")}`;
    if (!knownIds.includes(clientId)) knownIds.push(clientId);
    const realKey = keys.get(code.toUpperCase());
    const hostKey = kind === "host" ? (r.chance(0.7) ? realKey : r.chance(0.5) ? "wrong-key" : r.chance(0.5) ? r.pick([...keys.values()]) : undefined) : r.chance(0.05) ? realKey : undefined;
    const raw = JSON.stringify({
      type: "JOIN",
      clientId,
      roomCode: code,
      kind,
      plays: r.chance(0.5),
      hostKey,
      name: r.chance(0.5) ? `N${r.int(99)}` : undefined,
      device: { userAgent: "ua".repeat(r.int(200)), platform: "p", browserFamily: r.pick(FAMILIES), model: r.chance(0.3) ? "m" : undefined },
      protocolVersion: r.chance(0.9) ? PROTOCOL_VERSION : r.int(9),
    });
    return { raw, clientId, kind, code: code.toUpperCase(), hostKey };
  }

  function validMessage(s: Sock): unknown {
    const room = s.room ? mgr.get(s.room) : undefined;
    const track = room?.room.track;
    const num = () => r.pick([0, 1, -1, 3.5, 12, -40, 250, 5000, 1e9, -1e9]);
    switch (r.int(17)) {
      case 0:
        return { type: "SET_TRACK", trackId: r.chance(0.9) ? r.pick(LIBRARY).id : "no-such-track" };
      case 1:
      case 2:
        return { type: "TRANSPORT", action: r.pick(["PLAY", "PLAY", "PAUSE", "SEEK"]), trackTimeSec: r.pick([undefined, undefined, 0, r.next() * (track?.durationSec ?? 5) * 1.5, 1e9]) };
      case 3:
        return {
          type: "SET_MODE",
          mode: r.pick(MODES),
          params: r.chance(0.5)
            ? {}
            : { axis: r.pick(["x", "y"]), spanMs: r.int(300), periodMs: 100 + r.int(7900), duty: 0.05 + r.next() * 0.95, groups: 1 + r.int(8), beatsPerSwitch: r.pick([0.25, 0.5, 1, 2, 4]), stemGainsDb: { drums: -60 + r.int(72), mix: 3 } },
        };
      case 4:
        return { type: "ASSIGN", clientId: someId(room), role: r.pick([...STEMS, null]) };
      case 5:
        return { type: "SET_POSITION", clientId: someId(room), x: r.next(), y: r.pick([0, 1, r.next()]) };
      case 6:
        return { type: "NUDGE", clientId: r.chance(0.5) && s.clientId ? s.clientId : someId(room), nudgeMs: -100 + r.int(201) };
      case 7:
        return { type: "SET_PLAYS", plays: r.chance(0.5) };
      case 8:
        return r.chance(0.3) ? { type: "KICK", clientId: someId(room) } : { type: "PONG" };
      case 9:
        return { type: "AUDIO_READY", trackId: r.chance(0.7) && track ? track.id : r.pick(["short", "medium", "junk", ""]) };
      case 10:
        return { type: "CLIENT_STATUS", rttMs: r.pick([null, num()]), syncErrMs: r.pick([null, num()]), outputLatencyMs: r.pick([null, null, 0, 20, 85.5, num()]), audioState: r.pick(["locked", "unlocked", "loading", "ready"]) };
      case 11:
        return { type: "CALIBRATION_START", referenceClientId: r.chance(0.6) && s.clientId ? s.clientId : someId(room) };
      case 12:
        return r.chance(0.5) ? { type: "CALIBRATION_CANCEL" } : { type: "CALIBRATION_RESET", clientId: r.chance(0.5) ? someId(room) : undefined };
      case 13:
        return { type: "CALIBRATION_REPORT", measurements: Array.from({ length: 1 + r.int(4) }, () => ({ clientId: someId(room), residualMs: r.pick([0, 12, -7.25, 300, -300, 1e6]), confidence: r.pick([0, 0.4, 0.5, 0.9, 1]) })) };
      case 14:
        return { type: "NTP_REQUEST", t0: wallNow(), probeGroupId: r.int(50), probeGroupIndex: r.pick([0, 1, undefined]) };
      default:
        return { type: "PONG" };
    }
  }

  const GARBAGE = [
    "",
    "not json",
    "null",
    "[]",
    "42",
    '{"type":"NOPE"}',
    '{"type":"TRANSPORT"}',
    '{"type":"TRANSPORT","action":"PLAY","trackTimeSec":1e999}',
    '{"type":"TRANSPORT","action":"SEEK","trackTimeSec":-1}',
    '{"type":"NUDGE","clientId":"x","nudgeMs":1e999}',
    '{"type":"SET_POSITION","clientId":"x","x":2,"y":0}',
    '{"type":"CLIENT_STATUS","rttMs":1e999,"syncErrMs":null,"outputLatencyMs":-1e999,"audioState":"ready"}',
    '{"type":"CALIBRATION_REPORT","measurements":[]}',
    '{"type":"CALIBRATION_REPORT","measurements":[{"clientId":"x","residualMs":1e999,"confidence":1}]}',
    `{"type":"AUDIO_READY","trackId":"${"x".repeat(5000)}"}`,
    `{"type":"CALIBRATION_START","referenceClientId":"${"r".repeat(5000)}"}`,
    '{"type":"JOIN"}',
    '{"type":"SET_MODE","mode":"STROBE","params":{"groups":0}}',
    '{"__proto__":{"type":"PONG"},"type":"PONG","constructor":{"prototype":{"host":true}}}',
  ];

  /** The parts of a room only a host may change — as seen by `sender`, for a non-JOIN message. */
  function hostOnlyView(room: RoomState, senderId: string | null): string {
    const senderIsReference = senderId !== null && room.calibration.referenceClientId === senderId;
    return JSON.stringify({
      track: room.track,
      transport: room.transport,
      mode: room.mode,
      scenePlan: room.scenePlan,
      hostClientIds: room.hostClientIds,
      calibration: senderIsReference ? null : room.calibration,
      clients: Object.values(room.clients)
        .sort((a, b) => a.joinIndex - b.joinIndex)
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          plays: c.plays,
          position: c.position,
          pinnedRole: c.pinnedRole,
          name: c.name,
          // a client may nudge itself; the calibration reference may write measured offsets
          nudgeMs: c.id === senderId ? null : c.nudgeMs,
          calibratedOffsetMs: senderIsReference ? null : c.calibratedOffsetMs,
          // a client's own CLIENT_STATUS may retire its own table guess
          tableLatencyMs: c.id === senderId ? null : c.tableLatencyMs,
          connected: c.id === senderId ? null : c.connected,
        })),
    });
  }
  /** What a JOIN from a socket without the key must leave alone. */
  function joinView(room: RoomState): string {
    return JSON.stringify({
      track: room.track,
      transport: room.transport,
      mode: room.mode,
      scenePlan: room.scenePlan,
      calibration: room.calibration,
      hostClientIds: room.hostClientIds,
      // (assignments are recomputed for everyone on any join; everything else about a host is off limits)
      hosts: Object.values(room.clients)
        .filter((c) => c.kind === "host")
        .map((c) => ({ ...c, assignment: null })),
      ids: Object.keys(room.clients).sort(),
    });
  }

  function checkInvariants(afterAdvance: boolean) {
    expect(roomsOf().size).toBeLessThanOrEqual(MAX_ROOMS);
    // (a held JOIN owns exactly one timer: its NO_ROOM deadline)
    if (roomsOf().size === 0 && jest.getTimerCount() !== mgr.parkedCount) throw new Error(`no rooms left, but ${jest.getTimerCount()} timer(s) still armed (${mgr.parkedCount} held JOINs)`);
    for (const code of keyed.keys()) if (!roomsOf().has(code)) keyed.delete(code); // a re-created room starts with no hosts
    for (const room of roomsOf().values()) {
      const state = room.room;
      const wire = JSON.stringify(state);
      lastWire = wire;
      const parsed = RoomStateSchema.safeParse(JSON.parse(wire));
      if (!parsed.success) throw new Error(`ROOM_STATE fails its schema: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);

      const clients = Object.values(state.clients);
      const hostsExempt = clients.filter((c) => c.kind === "host").length;
      expect(clients.length).toBeLessThanOrEqual(MAX_ROOM_CLIENTS + hostsExempt);
      for (const c of clients) {
        if (c.plays !== (c.assignment !== null)) throw new Error(`client ${c.id}: plays=${c.plays} but assignment=${JSON.stringify(c.assignment)}`);
        if (c.kind === "viewer" && c.plays) throw new Error(`viewer ${c.id} is a speaker`);
        if (c.kind === "player" && !c.plays) throw new Error(`player ${c.id} is not a speaker`);
        const sock = room.sockets.get(c.id);
        if (c.connected !== (sock !== undefined)) throw new Error(`client ${c.id}: connected=${c.connected} but socket registered=${sock !== undefined}`);
        if (sock && sock.data.clientId !== c.id) throw new Error(`socket registered for ${c.id} identifies as ${sock.data.clientId}`);
      }
      for (const id of state.hostClientIds) {
        if (!keyed.get(room.code)?.has(id)) throw new Error(`${id} is in hostClientIds of ${room.code} but never JOINed with that room's hostKey`);
      }
      const hostIds = clients.filter((c) => c.kind === "host").map((c) => c.id).sort();
      expect([...state.hostClientIds].sort()).toEqual(hostIds);
      expect(new Set(state.hostClientIds).size).toBe(state.hostClientIds.length);

      for (const id of room.health.keys()) if (!state.clients[id]) throw new Error(`health entry for ${id}, which has no record`);
      if (state.calibration.state === "done") coverage.calibrationsDone++;
      if (state.calibration.state === "failed") coverage.calibrationsFailed++;
      if (state.transport.state === "paused") coverage.pausedRooms++;

      const standby = (room as unknown as { standby: Map<string, WS[]> }).standby;
      for (const [id, ws] of [...room.sockets, ...[...standby].flatMap(([sid, list]) => list.map((w) => [sid, w] as [string, WS]))]) {
        const model = socks.find((s) => s.ws === ws);
        if (!model || !model.open) throw new Error(`a closed socket is still registered for ${id}`);
        if (!state.clients[id]) throw new Error(`a socket is registered for ${id}, which has no record`);
      }

      if (afterAdvance && state.transport.state === "playing" && state.track) {
        const pos = trackTimeSec(state.transport, wallNow());
        if (pos > state.track.durationSec + 0.001) throw new Error(`playing ${state.track.id} at ${pos}s, past its ${state.track.durationSec}s end`);
      }
    }
    // A socket that joined and is still open means its client is here: connected, in a room that exists.
    for (const s of socks) {
      if (!s.open || s.pendingClose || s.clientId === null || s.room === null) continue;
      const rec = mgr.get(s.room)?.room.clients[s.clientId];
      if (!rec?.connected) throw new Error(`socket for ${s.clientId} in ${s.room} is open, but its record is ${rec ? "disconnected" : "gone"}`);
    }
    // Nothing left to flush means every open socket holds the current state — the per-recipient
    // dedupe may skip a message only when it would have said what the socket already knows.
    for (const s of socks) {
      if (!s.open || s.pendingClose || s.room === null || s.welcomes.length === 0) continue;
      const room = roomsOf().get(s.room);
      if (!room || room.dirty || s.ws.data.roomCode === null) continue;
      if (s.lastState === null) throw new Error(`${s.clientId ?? "an observer"} in ${s.room} has never been sent a ROOM_STATE`);
      const got = JSON.parse(s.lastState) as RoomState;
      const serverId = s.ws.data.clientId;
      const rec = serverId ? room.room.clients[serverId] : undefined;
      if (serverId && !rec) continue; // kicked; its close is on the way
      if (rec?.kind === "player") {
        const { clients: _c, calibration: _cal, hostClientIds: _h, ...level } = room.room;
        const { clients: gotClients, calibration: gotCal, hostClientIds: _gh, ...gotLevel } = got;
        if (JSON.stringify(gotLevel) !== JSON.stringify(JSON.parse(JSON.stringify(level)))) throw new Error(`player ${serverId} holds stale room-level state:
  has ${JSON.stringify(gotLevel)}
  now ${JSON.stringify(level)}`);
        if (JSON.stringify(gotClients[serverId!]) !== JSON.stringify(rec)) throw new Error(`player ${serverId} holds a stale copy of its own record`);
        if (gotCal.state !== room.room.calibration.state || gotCal.startServerTime !== room.room.calibration.startServerTime) throw new Error(`player ${serverId} holds a stale calibration state`);
      } else if (s.lastState !== JSON.stringify(room.room)) {
        throw new Error(`${rec?.kind ?? "observer"} ${serverId ?? ""} in ${s.room} holds a stale roster`);
      }
    }
  }

  let step = 0;
  let action = "";
  try {
    for (step = 0; step < steps; step++) {
      deliverCloses();
      const live = socks.filter((s) => s.open && !s.pendingClose);
      const roll = r.next();
      let advanced = false;

      if (live.length < 4 || (roll < 0.1 && live.length < 14)) {
        // ---- a new connection JOINs -------------------------------------------------------------
        const s = openSock();
        const j = joinMessage();
        action = `JOIN ${j.kind} ${j.clientId} → ${j.code}`;
        const room = mgr.get(j.code);
        const existing = room?.room.clients[j.clientId];
        const keyOk = j.kind === "host" && j.hostKey !== undefined && j.hostKey === (room?.hostKey ?? keys.get(j.code));
        const before = room && !keyOk ? joinView(room.room) : null;
        const waiting = socks.filter((o) => o.pendingJoin && o.welcomes.length === 0).length;
        s.pendingJoin = { clientId: j.clientId, code: j.code, keyOk };
        mgr.handleMessage(s.ws, j.raw);
        const welcomed = s.welcomes.length > 0;
        if (!welcomed) coverage.refusedJoins++;
        else if (existing?.kind === "host" && !keyOk) coverage.observers++;
        else if (keyOk) coverage.hostWelcomes++;
        else coverage.guestWelcomes++;
        if (welcomed && existing?.connected && !(existing.kind === "host" && !keyOk)) coverage.duplicateTabs++;
        if (welcomed && !room) coverage.restoredRooms++;
        // a restore lets in whoever was being held for that room
        coverage.heldJoinsAdmitted += waiting - socks.filter((o) => o !== s && o.pendingJoin && o.welcomes.length === 0).length;
        if (!welcomed && s.errors.length > 0) s.pendingJoin = null; // refused outright; otherwise it is being held
        if (before !== null && mgr.get(j.code)) {
          const after = JSON.parse(joinView(mgr.get(j.code)!.room)) as { ids: string[] };
          const b = JSON.parse(before) as { ids: string[] };
          // the only permitted difference: the joiner's own id appearing
          b.ids = [...new Set([...b.ids, ...(after.ids.includes(j.clientId) ? [j.clientId] : [])])].sort();
          expect(JSON.stringify(after)).toBe(JSON.stringify(b));
        }
      } else if (roll < 0.62) {
        // ---- a valid message from some socket ---------------------------------------------------
        const s = r.pick(live);
        const msg = validMessage(s);
        action = `${s.privileged ? "host" : "guest"} ${s.clientId} sends ${JSON.stringify(msg).slice(0, 160)}`;
        const room = s.room ? mgr.get(s.room) : undefined;
        const before = room && !s.privileged ? hostOnlyView(room.room, s.clientId) : null;
        const idsBefore = room ? Object.keys(room.room.clients).length : 0;
        const errorsBefore = s.errors.length;
        mgr.handleMessage(s.ws, r.chance(0.05) ? new TextEncoder().encode(JSON.stringify(msg)) : JSON.stringify(msg));
        if (!s.privileged && room && !s.pendingClose && HOST_ONLY_TYPES.has((msg as { type: string }).type)) {
          // (pendingClose: it just went over its message budget and was dropped unanswered)
          if (s.errors[errorsBefore] !== "NOT_HOST") throw new Error(`a socket without the hostKey sent ${(msg as { type: string }).type} and was answered ${s.errors[errorsBefore] ?? "nothing"}, not NOT_HOST`);
          coverage.notHostAnswers++;
        }
        if (room && Object.keys(room.room.clients).length < idsBefore) coverage.kicks++;
        if (before !== null && s.room && mgr.get(s.room)) expect(hostOnlyView(mgr.get(s.room)!.room, s.clientId)).toBe(before);
      } else if (roll < 0.7) {
        // ---- garbage, or a second JOIN on a socket that already has a seat ------------------------
        const s = r.pick(live);
        // (a socket whose first JOIN failed may still JOIN — that is not garbage, so it only gets garbage here)
        const raw = r.chance(0.3) && s.ws.data.roomCode !== null ? joinMessage().raw : r.pick(GARBAGE);
        action = `${s.clientId} sends garbage ${raw.slice(0, 80)}`;
        const all = [...roomsOf().values()].map((room) => JSON.stringify(room.room));
        mgr.handleMessage(s.ws, raw);
        expect([...roomsOf().values()].map((room) => JSON.stringify(room.room))).toEqual(all); // none of it changes anything
      } else if (roll < 0.78) {
        const s = r.pick(live);
        action = `close ${s.clientId}`;
        s.pendingClose = true;
      } else if (roll < 0.82) {
        // ---- REST-level events --------------------------------------------------------------------
        const code = r.pick([...keys.keys()]);
        const pick = r.int(5);
        if (pick === 0) {
          action = `POST /rooms {code:${code}} without the key`;
          const res = mgr.createRoom(code, r.chance(0.5) ? "guess" : undefined);
          if (!("error" in res)) throw new Error(`createRoom handed out a key for ${code}: ${JSON.stringify(res)}`);
        } else if (pick === 1) {
          action = `POST /rooms {code:${code}, hostKey}`;
          const res = mgr.createRoom(code, keys.get(code));
          if ("error" in res || res.hostKey !== keys.get(code)) throw new Error(`the host could not re-claim ${code}: ${JSON.stringify(res)}`);
        } else if (pick === 2 && keys.size < 5) {
          action = "POST /rooms {}";
          newRoom();
        } else if (pick === 3) {
          action = "library change";
          setLibrary(r.chance(0.3) ? LIBRARY.slice(0, 1 + r.int(LIBRARY.length)) : r.chance(0.5) ? [...LIBRARY].reverse() : LIBRARY);
        } else {
          const room = mgr.get(code);
          const plan: ScenePlan = {
            prompt: "fuzz",
            source: "rules",
            createdAtServerTime: wallNow(),
            scenes: [0, 1 + r.int(4), 6 + r.int(10), 30].slice(0, 1 + r.int(4)).map((atTrackSec, i) => ({ atTrackSec, mode: r.pick(MODES), params: {}, note: `s${i}` })),
          };
          action = `vibe plan lands on ${code}`;
          room?.acceptScenePlan(plan, r.chance(0.3) ? room.getModeVersion() - 1 : room.getModeVersion());
        }
      } else {
        const ms = r.pick([1, 1, 20, 150, 400, 600, 700, 2500, 5200, 9000, 21_000, 46_000, 125_000, 125_000, 610_000]);
        action = `advance ${ms} ms`;
        const was = new Map([...roomsOf()].map(([code, room]) => [code, { track: room.room.track?.id, mode: room.room.mode.kind, playing: room.room.transport.state === "playing" }]));
        const hangupsBefore = socks.filter((s) => s.pendingClose).length;
        jest.advanceTimersByTime(ms);
        advanced = true;
        for (const [code, w] of was) {
          const room = roomsOf().get(code);
          if (!room) coverage.collectedRooms++;
          else if (w.playing && room.room.track?.id !== w.track) coverage.playlistAdvances++;
          else if (w.playing && room.room.mode.kind !== w.mode) coverage.sceneModeSwitches++;
        }
        coverage.serverHangups += socks.filter((s) => s.pendingClose).length - hangupsBefore;
      }
      checkInvariants(advanced);
    }

    // ---- everyone leaves: the server must end up empty ------------------------------------------
    action = "teardown";
    for (const s of socks) s.pendingClose = true;
    deliverCloses();
    jest.advanceTimersByTime(DISCONNECT_RETENTION_MS + 1000);
    checkInvariants(true);
    // In small steps, so the timer count is read the moment the last room goes — a timer that
    // outlives its room by a few seconds is still a leak.
    for (let waited = 0; roomsOf().size > 0 && waited < ROOM_IDLE_TTL_MS + ROOM_UNCLAIMED_TTL_MS + 5000; waited += 500) jest.advanceTimersByTime(500);
    expect(roomsOf().size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  } catch (e) {
    throw new Error(`fuzz seed ${seed}, step ${step} (${action}): ${e instanceof Error ? e.message : e}\nlast state: ${String(lastWire).slice(0, 600)}`);
  }
}

beforeEach(() => void jest.useFakeTimers());
afterEach(() => void jest.useRealTimers());

describe("SG-13: stateful fuzz of the room server", () => {
  // A longer soak: HIVE_FUZZ_SEEDS=500 HIVE_FUZZ_STEPS=4000 bun test src/__tests__/room-fuzz.test.ts
  const seedCount = Number(process.env.HIVE_FUZZ_SEEDS ?? 24);
  const steps = Number(process.env.HIVE_FUZZ_STEPS ?? 1500);
  const SEEDS = Array.from({ length: seedCount }, (_, i) => 1000 + i * 7919);
  test(`${SEEDS.length} seeds × ${steps} steps: invariants hold after every step and the server ends empty`, () => {
    for (const seed of SEEDS) runSeed(seed, steps);
    // The run must have actually been to all of these places.
    for (const [what, count] of Object.entries(coverage)) {
      if (count === 0) throw new Error(`the fuzz never exercised: ${what} — ${JSON.stringify(coverage)}`);
    }
    if (process.env.HIVE_FUZZ_SEEDS) console.log("fuzz coverage", coverage);
  }, 1_800_000);
});
