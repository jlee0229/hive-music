/**
 * WebSocket layer: parse, authorize, dispatch. All room state lives in room.ts; this file only
 * decides *who may say what* and answers the NTP probes.
 *
 * NTP is the reason this file is thin. `t1` is stamped as the first statement of `message()` —
 * before schema validation, before any lookup — and `t2` right before the send, so the
 * `(t2 − t1)` the client subtracts really is the server's processing time. Anything that walks
 * the room in between would show up as clock error on every phone.
 *
 * Error codes (docs/02-protocol.md §5 plus the open set `ERROR.code` allows):
 *   BAD_MESSAGE · NO_ROOM · NOT_JOINED · NOT_HOST · FORBIDDEN · NO_TRACK · ROOM_FULL · KICKED
 */
import {
  PROTOCOL_VERSION, parseClientMessage,
  type ClientMessage, type ServerMessage,
} from "@hive/protocol";
import { serverNow } from "./clock";
import type { TrackLibrary } from "./library";
import type { Room } from "./room";
import type { RoomRegistry } from "./rooms";

export interface WsData {
  clientId: string | null;
  roomCode: string | null;
}

export interface WsDeps {
  rooms: RoomRegistry;
  library: TrackLibrary;
  log: (...a: unknown[]) => void;
}

type Ws = Bun.ServerWebSocket<WsData>;

const send = (ws: Ws, msg: ServerMessage): void => {
  ws.send(JSON.stringify(msg));
};
const fail = (ws: Ws, code: string, message: string): void => send(ws, { type: "ERROR", code, message });

/** Messages only the host may send. `SET_PLAYS` is host-only because players are always speakers. */
const HOST_ONLY: ReadonlySet<ClientMessage["type"]> = new Set([
  "SET_TRACK", "TRANSPORT", "SET_MODE", "ASSIGN", "SET_POSITION", "KICK", "SET_PLAYS", "CALIBRATION_START",
]);

export function onOpen(_ws: Ws): void {
  // The room topic is unknown until JOIN names it, so subscription happens there.
}

export function onClose(ws: Ws, deps: WsDeps): void {
  const { clientId, roomCode } = ws.data;
  if (!clientId || !roomCode) return;
  deps.rooms.get(roomCode)?.detach(clientId, ws);
}

export function onMessage(ws: Ws, raw: string | Buffer, deps: WsDeps): void {
  const t1 = serverNow(); // receive stamp: first statement, before parsing (see the file header)
  const msg = parseClientMessage(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  if (!msg) return fail(ws, "BAD_MESSAGE", "message failed schema validation");

  if (msg.type === "NTP_REQUEST") {
    return send(ws, {
      type: "NTP_RESPONSE",
      t0: msg.t0,
      t1,
      t2: serverNow(),
      probeGroupId: msg.probeGroupId,
      probeGroupIndex: msg.probeGroupIndex,
    });
  }

  if (msg.type === "JOIN") return handleJoin(ws, msg, deps);

  const room = ws.data.roomCode ? deps.rooms.get(ws.data.roomCode) : undefined;
  const clientId = ws.data.clientId;
  if (!room || !clientId || !room.client(clientId)) return fail(ws, "NOT_JOINED", "send JOIN first");

  if (HOST_ONLY.has(msg.type) && !room.isHost(clientId)) return fail(ws, "NOT_HOST", `${msg.type} is host only`);
  room.touch();
  dispatch(ws, room, clientId, msg, deps);
}

function handleJoin(ws: Ws, msg: Extract<ClientMessage, { type: "JOIN" }>, deps: WsDeps): void {
  const room = deps.rooms.get(msg.roomCode);
  if (!room) return fail(ws, "NO_ROOM", `room ${msg.roomCode.toUpperCase()} does not exist`);

  // A client that reloads onto a new socket while the old one is still open: drop the old record's socket.
  if (ws.data.clientId && ws.data.clientId !== msg.clientId && ws.data.roomCode) {
    deps.rooms.get(ws.data.roomCode)?.detach(ws.data.clientId, ws);
  }

  const result = room.join(ws, {
    clientId: msg.clientId,
    kind: msg.kind,
    plays: msg.plays,
    hostKey: msg.hostKey,
    name: msg.name,
    device: msg.device,
  });
  if (!result.ok) return fail(ws, result.code, result.message);

  ws.data.clientId = result.record.id;
  ws.data.roomCode = room.code;
  ws.subscribe(room.code);

  // A mismatched protocolVersion is not fatal: WELCOME carries ours and a stale bundle reloads itself.
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    deps.log(`join ${result.record.id} with protocol v${msg.protocolVersion} (server v${PROTOCOL_VERSION})`);
  }

  send(ws, {
    type: "WELCOME",
    clientId: result.record.id,
    roomCode: room.code,
    serverTime: serverNow(),
    protocolVersion: PROTOCOL_VERSION,
    isHost: result.record.kind === "host",
  });
  room.sendSnapshot(ws); // a joiner gets its snapshot immediately, outside the coalescer
  room.flush(); // and everyone else learns about it on the next window
  deps.log(`join ${result.record.kind} ${result.record.name} (${result.record.id}) → ${room.code}`);
}

function dispatch(ws: Ws, room: Room, clientId: string, msg: ClientMessage, deps: WsDeps): void {
  switch (msg.type) {
    case "PONG":
      return room.seen(clientId);

    case "CLIENT_STATUS":
      return room.reportStatus(clientId, {
        rttMs: msg.rttMs,
        syncErrMs: msg.syncErrMs,
        outputLatencyMs: msg.outputLatencyMs,
        audioState: msg.audioState,
      });

    case "AUDIO_READY":
      return room.audioReady(clientId, msg.trackId);

    case "SET_PLAYS":
      return room.setPlays(clientId, msg.plays);

    case "SET_TRACK": {
      const info = deps.library.info(msg.trackId);
      if (!info) return fail(ws, "NO_TRACK", `unknown track ${msg.trackId}`);
      return room.setTrack(info);
    }

    case "TRANSPORT":
      if (!room.state.track) return fail(ws, "NO_TRACK", "SET_TRACK first");
      return room.transport(msg.action, msg.trackTimeSec);

    case "SET_MODE":
      return room.setMode(msg.mode, msg.params);

    case "ASSIGN":
      return room.assign(msg.clientId, msg.role);

    case "SET_POSITION":
      return room.setPosition(msg.clientId, { x: msg.x, y: msg.y });

    case "NUDGE":
      // A player may nudge itself; only a host may nudge someone else (docs R-0 / PR-000).
      if (msg.clientId !== clientId && !room.isHost(clientId)) {
        return fail(ws, "FORBIDDEN", "players may only nudge themselves");
      }
      return room.nudge(msg.clientId, msg.nudgeMs);

    case "KICK":
      if (msg.clientId === clientId) return fail(ws, "FORBIDDEN", "a host cannot kick itself");
      return room.kick(msg.clientId);

    case "CALIBRATION_START":
      return room.startCalibration(msg.referenceClientId);

    case "CALIBRATION_REPORT":
      // Only the device that was told to listen may report what it heard.
      if (room.state.calibration.referenceClientId !== clientId) {
        return fail(ws, "FORBIDDEN", "only the calibration reference may report measurements");
      }
      return room.applyCalibrationReport(msg.measurements);
  }
}
