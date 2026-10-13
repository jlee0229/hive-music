/**
 * Putting the show back after a server restart (PARTY-02), pulled out of the host page so the
 * decision can be unit-tested.
 *
 * Rooms live in the server's memory. After a deploy or a crash the host's key re-creates the room
 * under the same code, but empty: no song, stopped, UNISON. The host page saw every snapshot of the
 * show, so it keeps the last one (`recordShow`) and, on the first snapshot after its socket reopens,
 * decides whether to re-issue the ordinary host commands (`planResume`). Nothing here is a new
 * message: SET_TRACK, SET_MODE and TRANSPORT PLAY with a position are what the stage already sends.
 */
import { LEAD_MS, ROOM_IDLE_TTL_MS, type RoomState } from "@hive/protocol";

/**
 * Longer away than this and the music does not start by itself any more (the song and the mode are
 * still put back). Half the server's idle timeout on purpose: a room re-created inside this window
 * cannot have ended because everybody left, so it can only be a restart.
 */
export const RESUME_MAX_AWAY_MS = ROOM_IDLE_TTL_MS / 2;

/** What the host page remembers of the most recent snapshot in which it was the host. */
export interface LastShow {
  /** `room.createdAtServerTime`: a different value on the next snapshot means the server re-created the room. */
  roomBornAt: number;
  trackId: string;
  durationSec: number;
  mode: RoomState["mode"];
  transport: RoomState["transport"];
}

export function recordShow(room: RoomState): LastShow | null {
  if (!room.track) return null;
  return { roomBornAt: room.createdAtServerTime, trackId: room.track.id, durationSec: room.track.durationSec, mode: room.mode, transport: room.transport };
}

export type ResumePlan =
  /** Leave the room exactly as the server has it. */
  | { kind: "nothing" }
  /** The song list has not loaded yet: ask again when it has. */
  | { kind: "wait" }
  /** Send SET_TRACK, SET_MODE and — only when `playFromSec` is a number — PLAY at that position. */
  | { kind: "restore"; trackId: string; mode: RoomState["mode"]; playFromSec: number | null };

export function planResume(input: {
  /** The show as it was when the socket dropped; null when this page never saw one. */
  last: LastShow | null;
  /** The first snapshot after the socket reopened. */
  room: RoomState;
  /** The server's own answer for this socket (WELCOME.isHost). */
  isHost: boolean;
  /** Ids in the host's song list; empty while it is still loading. */
  libraryTrackIds: readonly string[];
  /** Server clock when the socket dropped, and now. */
  droppedAtServerTime: number;
  serverNow: number;
}): ResumePlan {
  const { last, room } = input;
  if (!last || !input.isHost) return { kind: "nothing" };
  // The server kept the room: an ordinary network blip. Whatever the room says now is the show —
  // including a song another host device changed or stopped while this phone was away.
  if (room.createdAtServerTime === last.roomBornAt) return { kind: "nothing" };
  // A new room that is already moving: another host device got there first.
  if (room.transport.state !== "stopped") return { kind: "nothing" };
  if (input.libraryTrackIds.length === 0) return { kind: "wait" };
  if (!input.libraryTrackIds.includes(last.trackId)) return { kind: "nothing" };

  const away = input.serverNow - input.droppedAtServerTime;
  if (last.transport.state !== "playing" || away > RESUME_MAX_AWAY_MS) {
    // Paused, stopped, or away too long: the song and the mode come back, the music does not start.
    // And only into a room nobody has touched — a song already chosen there is somebody's choice.
    if (room.track) return { kind: "nothing" };
    return { kind: "restore", trackId: last.trackId, mode: last.mode, playFromSec: null };
  }
  // PLAY(from) means "position `from` at server time now + LEAD_MS", so asking for where the old
  // timeline will be at that instant puts every phone back on the timeline it was already on.
  const at = (input.serverNow + LEAD_MS - last.transport.serverTimeAtTrackZero) / 1000;
  // Past the end (the next song would have started by now) or not begun yet (dropped inside the
  // breather before a song): start this song from the top rather than guess at the playlist.
  const playFromSec = at >= 0 && at < last.durationSec ? at : 0;
  return { kind: "restore", trackId: last.trackId, mode: last.mode, playFromSec };
}

/**
 * The record right after a restore was sent: what was asked for, in the re-created room. Snapshots
 * replace it as they arrive; it only matters if the socket drops again before the first one does.
 */
export function showAfterResume(last: LastShow, room: RoomState, playFromSec: number | null, serverNow: number): LastShow {
  return {
    ...last,
    roomBornAt: room.createdAtServerTime,
    transport: playFromSec === null ? { state: "stopped" } : { state: "playing", serverTimeAtTrackZero: serverNow + LEAD_MS - playFromSec * 1000 },
  };
}
