/**
 * Audit tool (protocol-planner, PROTO-12): the same black-box probes against the mock and against the
 * real apps/server, printed as one JSON object each so the two can be diffed.
 *
 *   PORT=8840 bun run --cwd apps/server dev
 *   PORT=8141 bun run packages/protocol/src/mock-server.ts --scenario <empty scenario>
 *   bun run packages/protocol/scripts/parity-probe.ts http://localhost:8840 > real.json
 *   bun run packages/protocol/scripts/parity-probe.ts http://localhost:8141 > mock.json
 *
 * Localhost only. Every observation is a plain value; anything timing-dependent is reduced to a boolean.
 */
import { PROTOCOL_VERSION, parseServerMessage, type RoomState, type ServerMessage } from "../src/index";

const api = process.argv[2] ?? "http://localhost:8840";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(api)) throw new Error("localhost only");
const wsUrl = api.replace(/^http/, "ws") + "/ws";
const device = { userAgent: "Mozilla/5.0 (parity probe)", platform: "probe", browserFamily: "desktop-chrome" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Sock {
  ws = new WebSocket(wsUrl);
  msgs: ServerMessage[] = [];
  raw = 0;
  /** Every frame as text: "is another client's id anywhere in what this socket was sent" is about bytes. */
  texts: string[] = [];
  constructor() {
    this.ws.onmessage = (ev) => {
      this.raw++;
      this.texts.push(String(ev.data));
      const m = parseServerMessage(String(ev.data));
      if (m) this.msgs.push(m);
    };
  }
  open() { return new Promise<void>((r) => (this.ws.onopen = () => r())); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  join(clientId: string, roomCode: string, kind: "host" | "player" | "viewer", hostKey?: string, over: Record<string, unknown> = {}) {
    this.send({ type: "JOIN", clientId, roomCode, kind, plays: kind === "player", hostKey, device, protocolVersion: PROTOCOL_VERSION, ...over });
  }
  room(): RoomState | null {
    for (let i = this.msgs.length - 1; i >= 0; i--) { const m = this.msgs[i]!; if (m.type === "ROOM_STATE") return m.room; }
    return null;
  }
  errors() { return this.msgs.filter((m) => m.type === "ERROR").map((m) => (m as { code: string }).code); }
  has(type: ServerMessage["type"]) { return this.msgs.some((m) => m.type === type); }
}
async function sock() { const s = new Sock(); await s.open(); return s; }

const out: Record<string, unknown> = {};
const created = (await fetch(`${api}/rooms`, { method: "POST" }).then((r) => r.json())) as { code: string; hostKey: string };
const { code, hostKey } = created;

// --- REST ---------------------------------------------------------------------------------------
out.createUnknownCodeStatus = (await fetch(`${api}/rooms`, { method: "POST", body: JSON.stringify({ code: "ZZ99" }) })).status;
const lib = (await fetch(`${api.replace("localhost", "127.0.0.1")}/tracks`).then((r) => r.json())) as { tracks: Array<Record<string, unknown> & { id: string; title: string; urls: Record<string, string> }> };
out.tracksSortedByTitle = lib.tracks.map((t) => t.title).join("|") === [...lib.tracks.map((t) => t.title)].sort((a, b) => a.localeCompare(b)).join("|");
out.trackUrlsFollowRequestOrigin = Object.values(lib.tracks[0]!.urls)[0]!.startsWith("http://127.0.0.1");
const firstAudio = Object.values(lib.tracks[0]!.urls)[0]!.replace("127.0.0.1", "localhost");
const ranged = await fetch(firstAudio, { headers: { Range: "bytes=0-1" } });
out.audioRangeStatus = ranged.status;
out.audioCacheControl = ranged.headers.get("cache-control");
out.vibeEmptyPromptStatus = (await fetch(`${api}/rooms/${code}/vibe`, { method: "POST", body: JSON.stringify({ prompt: "" }) })).status;
out.vibeUnknownRoomStatus = (await fetch(`${api}/rooms/ZZ99/vibe`, { method: "POST", body: JSON.stringify({ prompt: "calm" }) })).status;
out.uploadRouteStatus = (await fetch(`${api}/tracks`, { method: "POST" })).status;

// --- join semantics -----------------------------------------------------------------------------
const lurker = await sock(); // never JOINs
const host = await sock();
host.join("host-0000-aaaa", code, "host", hostKey);
await sleep(300);
const player = await sock();
player.join("play-0000-aaaa", code, "player");
await sleep(700);
out.lurkerReceivedBeforeJoin = lurker.raw > 0;
out.storedUserAgent = host.room()!.clients["play-0000-aaaa"]!.device.userAgent;

// --- ROOM_STATE is per recipient: a player is sent the room-level state and its own record ---------
const ready = await sock(); // a second player; it announces AUDIO_READY before the calibration below
ready.join("play-0000-cccc", code, "player");
await sleep(700);
/** One recipient's latest snapshot, reduced to what tells the two views apart. */
const view = (s: Sock) => {
  const r = s.room();
  return r && { clientIds: Object.keys(r.clients).sort(), hostClientIds: r.hostClientIds, hostConnected: r.hostConnected ?? null };
};
const firstState = player.msgs.find((m) => m.type === "ROOM_STATE") as { room: RoomState } | undefined;
out.playerFirstSnapshotClientIds = firstState ? Object.keys(firstState.room.clients) : null; // the one sent on JOIN is its own view too
out.playerView = view(player);
out.hostView = view(host);

const viewer = await sock();
viewer.join("view-0000-aaaa", code, "viewer");
await sleep(1600);
out.viewerGetsHealth = viewer.has("HEALTH");
out.playerGetsHealth = player.has("HEALTH");
out.viewerView = view(viewer);
// the same id comes back as a player (the /screen tab's browser then opens /j)
const viewerAsPlayer = await sock();
viewerAsPlayer.join("view-0000-aaaa", code, "player");
await sleep(700);
const vp = host.room()!.clients["view-0000-aaaa"]!;
out.viewerRejoinsAsPlayer = { kind: vp.kind, plays: vp.plays, hasAssignment: vp.assignment !== null };
// the older socket of that id is still open; what it is sent follows the record, which is a player's now
out.olderSocketOfIdThatBecamePlayer = view(viewer);
// a second host, which then re-joins as a viewer
const host2 = await sock();
host2.join("host-0002-bbbb", code, "host", hostKey);
await sleep(600);
const host2v = await sock();
host2v.join("host-0002-bbbb", code, "viewer");
await sleep(700);
out.hostRejoinsAsViewer = { kind: host.room()!.clients["host-0002-bbbb"]!.kind, stillInHostIds: host.room()!.hostClientIds.includes("host-0002-bbbb") };
out.keylessSocketOnHostIdView = view(host2v); // an observer: it watches the whole room
host.send({ type: "KICK", clientId: "host-0002-bbbb" });
await sleep(700);
out.kickedHostLeftHostIds = !host.room()!.hostClientIds.includes("host-0002-bbbb");

// --- live latency -------------------------------------------------------------------------------
out.tableLatencyBeforeStatus = host.room()!.clients["play-0000-aaaa"]!.tableLatencyMs;
player.send({ type: "CLIENT_STATUS", rttMs: 10, syncErrMs: 2, outputLatencyMs: 37, audioState: "ready" });
await sleep(700);
out.tableLatencyAfterLiveOutputLatency = host.room()!.clients["play-0000-aaaa"]!.tableLatencyMs;

// --- tracks and transport -----------------------------------------------------------------------
const trackIds = lib.tracks.map((t) => t.id);
host.send({ type: "SET_TRACK", trackId: trackIds[0] });
await sleep(700);
host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
await sleep(700);
host.send({ type: "SET_TRACK", trackId: "no-such-track" });
await sleep(700);
out.unknownTrack = { errors: host.errors().filter((c) => c === "NO_TRACK").length, transportAfter: host.room()!.transport.state, trackKept: host.room()!.track?.id === trackIds[0] };
out.trackInfoKeys = Object.keys(host.room()!.track ?? {}).sort().join(",");

// --- calibration --------------------------------------------------------------------------------
for (const s of [viewerAsPlayer, ready]) s.send({ type: "AUDIO_READY", trackId: host.room()!.track!.id });
await sleep(700);
host.send({ type: "CALIBRATION_START", referenceClientId: "view-0000-aaaa" }); // a player's phone listens
await sleep(700);
out.calibrationOrderExcludesNotReady = !host.room()!.calibration.order.includes("play-0000-aaaa"); // never sent AUDIO_READY
// what each kind of recipient is told about the run: the host everything, a player its own slot only
const cal = (s: Sock) => { const c = s.room()!.calibration; return { state: c.state, referenceClientId: c.referenceClientId, order: c.order, results: c.results }; };
out.calibrationInFlight = { host: cal(host), referencePlayer: cal(viewerAsPlayer), clickingPlayer: cal(ready), playerWithoutSlot: cal(player) };
viewerAsPlayer.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-0000-cccc", residualMs: 4, confidence: 0.9 }] });
await sleep(700);
out.calibrationDone = { host: cal(host), referencePlayer: cal(viewerAsPlayer), clickingPlayer: cal(ready), playerWithoutSlot: cal(player) };
host.send({ type: "CALIBRATION_CANCEL" });
await sleep(700);
host.send({ type: "CALIBRATION_START", referenceClientId: "host-0000-aaaa" });
await sleep(700);
player.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "play-0000-aaaa", residualMs: 50, confidence: 0.9 }] });
await sleep(700);
out.reportFromNonReference = { state: host.room()!.calibration.state, offset: host.room()!.clients["play-0000-aaaa"]!.calibratedOffsetMs };
host.send({ type: "CALIBRATION_CANCEL" });
await sleep(300);

// --- vibe while playing applies the scene at the current position --------------------------------
host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
await sleep(700);
const vibe = (await fetch(`${api}/rooms/${code}/vibe`, { method: "POST", body: JSON.stringify({ prompt: "strobe rave" }) }).then((r) => r.json())) as { scenePlan: { scenes: Array<{ mode: string }> } };
await sleep(700);
out.vibeAppliesCurrentScene = host.room()!.mode.kind === vibe.scenePlan.scenes[0]!.mode;

// --- end of track -------------------------------------------------------------------------------
const dur = host.room()!.track!.durationSec;
const zeroBefore = (host.room()!.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero;
host.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec: dur - 1.2 });
await sleep(2600);
const after = host.room()!;
out.endOfTrack = {
  stillPlaying: after.transport.state === "playing",
  advancedOrRestarted: after.track!.id !== trackIds[0] || (after.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero > zeroBefore + 1000,
  advancedToAnotherTrack: after.track!.id !== trackIds[0],
  scenePlanClearedOnAdvance: after.scenePlan === null,
};

// --- the host leaves: the one thing a player is told about anyone else ---------------------------
host.ws.close();
await sleep(1200);
out.playerViewAfterHostLeft = view(player);
// Over the whole session: nothing a player was sent names another client. (Its own id and
// SCHEDULED_ACTION click ids are its own.) Hosts are sent every id, so the same test on the host is true.
const everyId = ["host-0000-aaaa", "play-0000-aaaa", "play-0000-cccc", "view-0000-aaaa", "host-0002-bbbb"];
const namesSomeoneElse = (s: Sock, own: string) => everyId.some((id) => id !== own && s.texts.some((t) => t.includes(id)));
out.playerWasSentAnotherClientsId = { "play-0000-aaaa": namesSomeoneElse(player, "play-0000-aaaa"), "play-0000-cccc": namesSomeoneElse(ready, "play-0000-cccc") };
out.hostWasSentOtherClientsIds = namesSomeoneElse(host, "host-0000-aaaa");

console.log(JSON.stringify(out, null, 1));
process.exit(0);
