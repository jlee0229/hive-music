// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { IDLE_CALIBRATION, LEAD_MS, PROTOCOL_VERSION, type RoomState } from "@hive/protocol";
import { RESUME_MAX_AWAY_MS, planResume, recordShow, showAfterResume } from "./resume-show";

const T0 = 1_760_000_000_000; // a server clock reading (ms epoch)
const SONG = { id: "song-b", title: "B", durationSec: 60, stems: ["mix"] };
const FIRST = { id: "song-a", title: "A", durationSec: 30, stems: ["mix"] };
const LIBRARY = [FIRST.id, SONG.id];

function room(over: Partial<RoomState> = {}): RoomState {
  return {
    code: "BZQ7", protocolVersion: PROTOCOL_VERSION, createdAtServerTime: T0, hostClientIds: ["host"],
    track: SONG, transport: { state: "stopped" }, mode: { kind: "UNISON", params: {} }, scenePlan: null,
    calibration: IDLE_CALIBRATION, clients: {},
    ...over,
  };
}

/** The show before the drop: SONG in STROBE, started 20 s before T0. */
const STROBE: RoomState["mode"] = { kind: "STROBE", params: { groups: 3, beatsPerSwitch: 2 } };
const playing = room({ transport: { state: "playing", serverTimeAtTrackZero: T0 - 20_000 }, mode: STROBE });
/** What the server restores after a restart: a new room, no song, stopped, UNISON. */
const restored = room({ createdAtServerTime: T0 + 5_000, track: null });

/** Dropped at T0 (20 s into the song); the first snapshot arrives `awayMs` later. */
function ask(over: Partial<Parameters<typeof planResume>[0]> = {}, awayMs = 6_000) {
  return planResume({ last: recordShow(playing), room: restored, isHost: true, libraryTrackIds: LIBRARY, droppedAtServerTime: T0, serverNow: T0 + awayMs, ...over });
}

describe("recordShow", () => {
  test("keeps the song, the mode with its params, the transport and which room it was", () => {
    expect(recordShow(playing)).toEqual({ roomBornAt: T0, trackId: SONG.id, durationSec: 60, mode: STROBE, transport: { state: "playing", serverTimeAtTrackZero: T0 - 20_000 } });
  });
  test("a room with no song is not a show", () => {
    expect(recordShow(room({ track: null }))).toBeNull();
  });
});

describe("planResume: the server restarted mid-song", () => {
  test("puts back the song and the mode and plays where the song would be by now", () => {
    // 20 s in at the drop, 6 s away; PLAY lands LEAD_MS after it is sent.
    expect(ask()).toEqual({ kind: "restore", trackId: SONG.id, mode: STROBE, playFromSec: 26 + LEAD_MS / 1000 });
  });

  test("the resumed timeline is the old timeline: the server's new zero equals the old one", () => {
    const plan = ask();
    if (plan.kind !== "restore" || plan.playFromSec === null) throw new Error("expected a resume");
    // apps/server TRANSPORT PLAY: serverTimeAtTrackZero = now + LEAD_MS - from * 1000
    expect(T0 + 6_000 + LEAD_MS - plan.playFromSec * 1000).toBe(T0 - 20_000);
  });

  test("past the end of the song: the same song from the top, no playlist arithmetic", () => {
    expect(ask({}, 45_000)).toEqual({ kind: "restore", trackId: SONG.id, mode: STROBE, playFromSec: 0 });
  });

  test("dropped in the breather before the song had begun: from the top", () => {
    const upcoming = room({ transport: { state: "playing", serverTimeAtTrackZero: T0 + 30_000 } });
    expect(ask({ last: recordShow(upcoming) })).toMatchObject({ kind: "restore", playFromSec: 0 });
  });

  test("the restored room already holds a song but nothing is playing (another host page's auto-pick): still resume", () => {
    expect(ask({ room: room({ createdAtServerTime: T0 + 5_000, track: FIRST }) })).toMatchObject({ kind: "restore", trackId: SONG.id, playFromSec: 26 + LEAD_MS / 1000 });
    expect(ask({ room: room({ createdAtServerTime: T0 + 5_000, track: SONG }) })).toMatchObject({ kind: "restore", trackId: SONG.id });
  });
});

describe("planResume: guards", () => {
  test("no record (this page never saw a show): nothing", () => {
    expect(ask({ last: null })).toEqual({ kind: "nothing" });
  });

  test("this page is no longer the host: nothing", () => {
    expect(ask({ isHost: false })).toEqual({ kind: "nothing" });
  });

  test("an ordinary blip — the server kept the room and the song is still playing: nothing", () => {
    expect(ask({ room: playing })).toEqual({ kind: "nothing" });
  });

  test("the server kept the room and another host device stopped or changed the song meanwhile: nothing", () => {
    expect(ask({ room: room({ track: FIRST }) })).toEqual({ kind: "nothing" });
    expect(ask({ room: room({ transport: { state: "paused", trackTimeAtPause: 21 } }) })).toEqual({ kind: "nothing" });
    expect(ask({ room: room() })).toEqual({ kind: "nothing" });
  });

  test("a second host device has already started something in the restored room: nothing", () => {
    const started = room({ createdAtServerTime: T0 + 5_000, track: FIRST, transport: { state: "playing", serverTimeAtTrackZero: T0 + 5_500 } });
    expect(ask({ room: started })).toEqual({ kind: "nothing" });
    expect(ask({ room: { ...started, transport: { state: "paused", trackTimeAtPause: 1 } } })).toEqual({ kind: "nothing" });
  });

  test("the song list has not loaded: wait; loaded without the song: nothing", () => {
    expect(ask({ libraryTrackIds: [] })).toEqual({ kind: "wait" });
    expect(ask({ libraryTrackIds: [FIRST.id] })).toEqual({ kind: "nothing" });
  });

  test("a paused show comes back as its song and mode, never playing", () => {
    const paused = room({ transport: { state: "paused", trackTimeAtPause: 21 }, mode: STROBE });
    expect(ask({ last: recordShow(paused) })).toEqual({ kind: "restore", trackId: SONG.id, mode: STROBE, playFromSec: null });
  });

  test("a stopped show comes back as its song and mode, never playing", () => {
    expect(ask({ last: recordShow(room({ mode: STROBE })) })).toEqual({ kind: "restore", trackId: SONG.id, mode: STROBE, playFromSec: null });
  });

  test("a paused or stopped show does not overwrite a song somebody already chose in the restored room", () => {
    const paused = room({ transport: { state: "paused", trackTimeAtPause: 21 } });
    expect(ask({ last: recordShow(paused), room: room({ createdAtServerTime: T0 + 5_000, track: FIRST }) })).toEqual({ kind: "nothing" });
  });

  test("away longer than the limit: the song and mode come back, the music does not start by itself", () => {
    expect(ask({}, RESUME_MAX_AWAY_MS + 1)).toEqual({ kind: "restore", trackId: SONG.id, mode: STROBE, playFromSec: null });
    expect(ask({}, RESUME_MAX_AWAY_MS)).toMatchObject({ kind: "restore", playFromSec: 0 });
  });
});

describe("showAfterResume", () => {
  test("the record follows what was sent: same song and mode, the new room, the resumed timeline", () => {
    const last = recordShow(playing)!;
    expect(showAfterResume(last, restored, 26.6, T0 + 6_000)).toEqual({ ...last, roomBornAt: T0 + 5_000, transport: { state: "playing", serverTimeAtTrackZero: T0 + 6_000 + LEAD_MS - 26_600 } });
    expect(showAfterResume(last, restored, null, T0 + 6_000)).toEqual({ ...last, roomBornAt: T0 + 5_000, transport: { state: "stopped" } });
  });

  test("a second restart right after a resume resumes again, from the record alone", () => {
    const after = showAfterResume(recordShow(playing)!, restored, 26.6, T0 + 6_000);
    const again = room({ createdAtServerTime: T0 + 9_000, track: null });
    expect(planResume({ last: after, room: again, isHost: true, libraryTrackIds: LIBRARY, droppedAtServerTime: T0 + 7_000, serverNow: T0 + 10_000 })).toMatchObject({ kind: "restore", trackId: SONG.id, playFromSec: 30 + LEAD_MS / 1000 });
  });
});
