# 02 · Protocol — the contract between server, sync-client and UI

This document mirrors `packages/protocol/src/*.ts`. **The code is the source of truth**; a test
(`packages/protocol/src/__tests__/schemas.test.ts`) fails if the message tables below drift from the
zod unions.

## 0. Versioning and deploy skew

**`PROTOCOL_VERSION = 4`**: v2 added `CALIBRATION_CANCEL`, v3 added `CALIBRATION_RESET`, v4 added `kind: "viewer"` on `JOIN`.

Web (Vercel) and server (Fly) deploy at different times, and phones keep a tab open for hours, so an old
bundle talking to a new server (and briefly the reverse) is normal. The rules:

| change | bump? | why |
|---|---|---|
| new **optional field** on an existing object (`Assignment.pitchSemitones`, `TrackInfo.beatOffsetSec`, `ModeParams.beatsPerSwitch` were added this way) | no | every object schema strips unknown keys; an old reader ignores it, an old server ignores it |
| new **enum value** a server can put in `ROOM_STATE` (a mode — `CHOIR` was added this way — a client kind, a role, a pattern kind) | no, from the bundle that has `RoomStateWireSchema` on | `ROOM_STATE` is read through `RoomStateWireSchema`, which degrades an unknown value to a safe default instead of failing the whole snapshot. Bundles older than that still drop every snapshot that contains the new value |
| new **client → server message or value** (a new `SET_MODE` mode, a new `JOIN.kind`) | yes | an old server answers `ERROR BAD_MESSAGE`; the bump is what makes a stale side notice |
| anything that changes the meaning of an existing field, a required field, or a tightened range a real client could hit | yes | |

Who checks: the web app compares its bundled version with `GET /health` once, at page load
(`apps/web/lib/hive/protocolVersionGuard.ts`): one reload, then a banner. Nothing compares versions on an
already-open tab — `WELCOME.protocolVersion` and `JOIN.protocolVersion` are carried but not read — so a tab
that reconnects after a server deploy keeps its old bundle. Deploy the **server first**: a new server
accepts everything an old bundle sends, and an old bundle with the wire schema survives everything a new
server sends.

Skew cases as of this revision:

| | old web tab | new web |
|---|---|---|
| **new server** | safe for UNISON/ORCHESTRA/STEREO/WAVE/STROBE (new optional fields are ignored; the planner runs server-side, so new arrangements just arrive as gains and patterns). A tab older than `CHOIR` drops every `ROOM_STATE` while the mode is CHOIR or a scene plan contains a CHOIR scene. | – |
| **old server** | – | safe to read. `SET_MODE CHOIR` and `JOIN kind: viewer` (pre-v4 server) get `BAD_MESSAGE`; `beatsPerSwitch` is stripped, so STROBE runs at the default beat. |

## 1. Timeline model

The **server clock is master**: `serverTime = performance.timeOrigin + performance.now()` on the server (ms, float).
Every phone estimates it with the NTP-style probes in §3 and never uses `Date.now()`.

There is exactly **one** source of truth for playback, `room.transport`:

| state | fields | meaning |
|---|---|---|
| `stopped` | – | nothing on the timeline |
| `playing` | `serverTimeAtTrackZero` | track position = `(serverTime − serverTimeAtTrackZero) / 1000` s |
| `paused` | `trackTimeAtPause` | frozen at that position |

- **PLAY** (host): server sets `serverTimeAtTrackZero = now + LEAD_MS − trackTimeSec·1000` with `LEAD_MS = 600`, so
  every phone has the same instant to start on. A phone that receives the state late computes the offset and starts
  immediately at the right position (`source.start(now, offsetSec)`), never waits.
- **PAUSE**: server stores `trackTimeAtPause`; phones stop on receipt (a 100 ms ragged pause edge is acceptable).
- **SEEK / resume** = a new PLAY with a new `serverTimeAtTrackZero`.
- **End of track** (server timer, `LEAD_MS` before the boundary; pure rules in `timeline.ts`): with another real
  (non-`generated`) song in the library the room **advances** to it — `track` changes, `scenePlan` is cleared,
  `serverTimeAtTrackZero = oldEnd + TRACK_ADVANCE_LEAD_MS` (2000 ms: phones have already downloaded it via `nextTrack` and only need to decode and schedule it) and the room is
  re-planned. With nothing to advance to, the same track **loops** seamlessly: `serverTimeAtTrackZero = oldEnd`.
  The transport never stays `playing` past the end.
- Late joiners, reconnects and tab-resume all use this same computation. No scheduled PLAY/PAUSE messages exist.

Client-side mapping of a server time to this device's speaker, with `estServerNow = performance.now() + clockOffset`:

```
ctxTime(serverTime) = ctx.currentTime
                    + (serverTime − estServerNow) / 1000
                    + assignment.delayMs / 1000            // deliberate spatial delay (WAVE)
                    − assignment.compensationMs / 1000     // positive = this device is late → advance it
                    − (no table AND no calibration ? (ctx.outputLatency || 0) : 0)
```

`compensationMs = nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0)` is computed **by the server** and delivered
inside the assignment, so the UI never adds these numbers itself. **Live latency:** the first `CLIENT_STATUS` that
reports `outputLatencyMs > 0` from an uncalibrated phone sets its `tableLatencyMs` to `null` (one-way): the phone then
subtracts its own live `ctx.outputLatency`, and the table guess leaves `compensationMs` in the same snapshot.

## 2. Units and conventions

- All wire times are **ms floats** on the server clock; durations in ms; track positions in **seconds**.
- Every number a client sends must be **finite** (`1e999` parses to Infinity and is refused).
- Positions: `x, y ∈ [0, 1]`, origin top-left, y down (the Hive Map canvas).
- Gains: dB per stem; `−60 dB` means silent. A non-separated track is a one-stem track named `mix`.
- `role` (`drums | bass | vocals | other | unison`) selects a color from `ROLE_COLORS`; `assignment` is the truth.
- Health colors come only from `healthLevel()`: `good ≤ 5 ms`, `warn ≤ 20 ms`, `bad` above or stale (>5 s), `unknown` without data.
  `syncErrMs := minRttMs/2 + max(|lastAppliedCorrectionMs|, |playheadErrorMs|)` (`computeSyncErrMs`); its sign is ignored.
- Identity: the client generates a UUID once, keeps it in `localStorage`, and sends it in `JOIN`; the server keeps a
  disconnected record for `DISCONNECT_RETENTION_MS = 120 000` so a reconnect restores the same `joinIndex`, position and assignment.
  Ids are 8–64 chars and may not be the name of an `Object.prototype` member (`toString`, `__proto__`, …): rooms index
  clients by id in plain objects.
- Rates: `ROOM_STATE` ≤ 2 Hz (coalesced, always a full snapshot); `HEALTH` 1 Hz to hosts **and viewers**; `CLIENT_STATUS` every 2 s;
  `SET_POSITION` throttled to 10 Hz inside the engine (the UI may call it on every pointer move); `PING` every 20 s.
- Unknown keys are stripped at every level of every message; nothing a client invents reaches room state.

## 3. Clock sync (NTP-style over the room WebSocket)

Ported from Beatsync's `ntp.ts`. Four timestamps per probe: `t0` client send, `t1` server receive, `t2` server send, `t3` client receive.

```
offset = ((t1 − t0) + (t2 − t3)) / 2        rtt = (t3 − t0) − (t2 − t1)
```

Schedule: a burst of 20 probes over 4 s at connect, then 1 Hz forever. Coded probe **pairs** (`probeGroupId`, `probeGroupIndex 0|1`)
sent 10 ms apart: a pair whose server-side inter-arrival differs from 10 ms by more than 2 ms is discarded (queueing).
Selection: the **minimum-RTT** probe within a sliding window of 30 (and no older than 30 s) keeps the offset; corrections are
slewed, never stepped, except the hard resync described in [03-sync-engine.md](03-sync-engine.md). Budget: ±2–5 ms on Wi-Fi.

## 4. Messages: client → server

Discriminated on `type`. Host-only messages return `ERROR NOT_HOST` from a player. A frame that fails the schema
returns `ERROR BAD_MESSAGE` and changes nothing.

| `type` | fields | who | notes |
|---|---|---|---|
| `JOIN` | `clientId, roomCode, kind: host\|player\|viewer, plays, hostKey?, name?, device{userAgent, platform, browserFamily, model?}, protocolVersion` | any | first message on the socket; `kind: host` needs a valid `hostKey` unless the id is already a host (or nobody holds the room). `kind: viewer` (v4) needs no key: the server forces `plays: false`, never adds it to `hostClientIds`, does not count it as a player, and sends it `HEALTH` as well as `ROOM_STATE`. The server never stores `device.userAgent` |
| `NTP_REQUEST` | `t0, probeGroupId?, probeGroupIndex?` | any | answered immediately with `NTP_RESPONSE` |
| `SET_TRACK` | `trackId` | host | loads the track into the room (transport → `stopped`); phones preload **all stems** and answer `AUDIO_READY`. Unknown id → `ERROR NO_TRACK`, nothing changes |
| `TRANSPORT` | `action: PLAY\|PAUSE\|SEEK, trackTimeSec?` | host | see §1 |
| `SET_MODE` | `mode, params` | host | clears `scenePlan` (manual override wins) and re-plans. `params.stemGainsDb` holds at most 8 stems |
| `ASSIGN` | `clientId, role\|null` | host | pin / unpin a player's stem |
| `SET_POSITION` | `clientId, x, y` | host | Hive Map drag; the engine throttles to 10 Hz |
| `NUDGE` | `clientId, nudgeMs ∈ [−100, 100]` | host or self | folds into `compensationMs` |
| `SET_PLAYS` | `plays` | host | "use this phone as a speaker too" |
| `KICK` | `clientId` | host | removes the client (and its host authority) |
| `AUDIO_READY` | `trackId` (1–64 chars) | any | all stems decoded for that track |
| `CLIENT_STATUS` | `rttMs, syncErrMs, outputLatencyMs, audioState` | any | every 2 s; feeds `HEALTH`; a live `outputLatencyMs` retires the latency-table guess (§1) |
| `CALIBRATION_START` | `referenceClientId` | host | the host phone is the listener; only connected speakers that announced `AUDIO_READY` for the current track get a click slot, in join order; see [04-calibration.md](04-calibration.md) |
| `CALIBRATION_CANCEL` | – | host | abandons a run: `calibration` → `idle`, no offsets written; clients drop their own pending clicks (v2) |
| `CALIBRATION_RESET` | `clientId?` | host | clears `calibratedOffsetMs` to `null` (one client, or all); refused with `ERROR CALIBRATION_BUSY` unless `calibration.state === "idle"`; unknown client → `ERROR NO_CLIENT` (v3) |
| `CALIBRATION_REPORT` | `measurements[{clientId, residualMs, confidence}]` (≤ 256) | reference | accepted only from `calibration.referenceClientId` and only while a run is live; the server accumulates `calibratedOffsetMs` for measurements with `confidence ≥ 0.5`. No report within 5 s of the last click → `calibration.state: failed` |
| `PONG` | – | any | liveness reply to `PING` |

## 5. Messages: server → client

| `type` | fields | to | notes |
|---|---|---|---|
| `WELCOME` | `clientId, roomCode, serverTime, protocolVersion, isHost` | joiner | `protocolVersion` is informational today (§0) |
| `NTP_RESPONSE` | `t0, t1, t2, probeGroupId?, probeGroupIndex?` | prober | |
| `ROOM_STATE` | `room` (full `RoomState`) | room | on any change, coalesced to ≤2 Hz; the joiner gets one immediately. A socket that has not joined receives nothing |
| `HEALTH` | `serverTime, clients{[id]: {rttMs, syncErrMs, outputLatencyMs, audioState, lastSeenServerTime}}` | hosts + viewers | 1 Hz (v4 adds viewers: a `/screen` display's median-sync tile is a median over exactly these numbers). `apps/server` does not send it to viewers yet — see the audit finding PROTO-12 |
| `SCHEDULED_ACTION` | `serverTimeToExecute, action{kind: CALIBRATION_CLICK, clickId, clickSpec}` | one player | the only scheduled action left; phones synthesize the click |
| `CALIBRATION_PLAN` | `startServerTime, intervalMs, order[], clickSpec` | reference | which phone clicks when |
| `PING` | `serverTime` | room | every 20 s |
| `ERROR` | `code, message` | one | `BAD_MESSAGE, NO_ROOM, NOT_HOST, NO_TRACK, NO_CLIENT, CALIBRATION_BUSY, KICKED` |

## 6. REST

| route | body → response |
|---|---|
| `GET /health` | `{ok, protocolVersion, serverTime}` |
| `POST /rooms` | `{code?}` → `{code, hostKey, joinUrl}`. No code: a new room with a random 4-char code. A code: that room if it exists (or is the fixed `ROOM_FIXED_CODE`, which survives a restart), else `400` |
| `GET /rooms/:code` | `{code, exists, players}` (`404` when it does not exist) |
| `GET /tracks?q=` | `{tracks: TrackLibraryEntry[]}` — the library (`fixtures/tracks/*/meta.json`), ordered by `meta.order` then title; each entry carries `urls{stem→wav}` built from the request's own origin, `bpm?`, `beatOffsetSec?`, `energy[]`, `clickTimesSec?`, `dropSec?`, `generated?` |
| `GET /audio/:trackId/:stem.wav` | 16-bit mono 44.1 kHz WAV; honours a single `Range` (iOS Safari probes with `bytes=0-1`) |
| `POST /rooms/:code/vibe` | `{prompt}` (1–500 chars) → `{scenePlan}` (LLM or rules fallback; see [05-effect-modes.md](05-effect-modes.md)); `404` unknown room, `400` bad prompt |
| `POST /tracks` | host upload (multipart: `mix`, or `drums`/`bass`/`vocals`/`other`); the server normalises, analyses energy / drop / tempo / beat grid and adds the track to the library. Not available on the mock (`501`) |

CORS: `Access-Control-Allow-Origin` = `CORS_ORIGIN` (the Vercel origin) on every route.

## 7. RoomState (what `ROOM_STATE` carries)

```ts
RoomState {
  code, protocolVersion, createdAtServerTime, hostClientIds: string[],
  track: { id, title, durationSec, stems: string[], bpm?, beatOffsetSec? } | null,
  transport: Transport,                       // §1
  mode: { kind: UNISON|ORCHESTRA|STEREO|WAVE|STROBE|CHOIR, params: ModeParams },
  scenePlan: ScenePlan | null,                // Vibe Director output, §9
  calibration: { state: idle|countdown|running|done|failed, referenceClientId, startServerTime, order[], results{[id]: {residualMs, confidence}} },
  clients: { [id]: ClientRecord }
}
ClientRecord {
  id, kind: host|player|viewer, plays, name, device, joinIndex, joinedAtServerTime,
  position: {x, y} | null, pinnedRole: drums|bass|vocals|other | null,
  nudgeMs, tableLatencyMs | null, calibratedOffsetMs | null,
  assignment: Assignment | null,              // null for a non-playing host and for a viewer
  connected, audioReadyTrackId | null
}
Assignment {
  label, role, color, gainsDb: { [stem]: dB }, delayMs, compensationMs,
  pattern: { kind: strobe|wave, periodMs, phaseMs, duty?, rampMs? } | null,   // periodMs / phaseMs are floats
  applyAtServerTime: number | null,           // scene boundaries: apply exactly then
  pitchSemitones?: integer                    // CHOIR only: re-render this phone's copy at this pitch
}
ModeParams { axis?, spanMs?, periodMs?, duty?, groups?, beatsPerSwitch?, stemGainsDb? }
```

Two schemas describe this shape. `RoomStateSchema` is strict: it is what producers and tests validate against.
`RoomStateWireSchema` is what `parseServerMessage` reads `ROOM_STATE` with: the same TypeScript type, but an unknown
`mode.kind` reads as `UNISON`, unparsable `mode.params` as `{}`, an unparsable `scenePlan` as `null`, an unknown client
`kind` as `viewer`, an unknown `role` as `unison`, an unknown `pattern` as `null`, an unknown `browserFamily` as `other`
(§0). Transport, track and the numeric assignment fields stay strict.

Invariants the UI may rely on:

1. Every snapshot is complete; render from it and never diff against earlier snapshots.
2. `assignment` is the pure output of `plan(room)` (`packages/protocol/src/planner.ts`), shared by the real server and the mock:
   deterministic, a joiner never changes which instrument / group / voice an existing speaker is, pins win, non-playing hosts
   and viewers get `null`, `UNISON` = every stem at 0 dB, and in every mode every stem of the track is audible on a connected
   speaker (see [05-effect-modes.md](05-effect-modes.md)).
3. Mode switches are **gain changes**, never reloads: phones hold all stems decoded from `SET_TRACK` on. (CHOIR is the
   exception by nature: a new pitch is an offline re-render on the phone.)
4. Patterns are evaluated client-side with `evaluatePattern(pattern, trackTimeMs)` on the shared clock — no per-tick messages.
5. `clients[id].position === null` means "not placed by hand". Such a speaker sits at its **auto-layout slot**:
   `speakerLayout(room).positions[id]` (`packages/protocol/src/layout.ts`), a pure function of the room that the planner
   uses for WAVE and STEREO and that the Hive Map must use to draw the dot — never a layout of the UI's own.
6. `connected` is an input to the planner (a speaker that is offline is not covering its stem), so the server should
   re-plan when a socket closes and when a retained record expires (the mock does; `apps/server` only re-publishes — PROTO-05).

## 8. Sync-health, colors, constants

`ROLE_COLORS`, `HEALTH_COLORS`, `healthLevel()`, `LEAD_MS`, `TRACK_ADVANCE_LEAD_MS`, the NTP schedule, the rate caps, the
STROBE slot bounds and the starter latency table all live in `packages/protocol/src/constants.ts` / `health.ts`.
Docs quote them; code defines them.

## 9. Vibe Director data

```ts
ScenePlan { prompt, source: llm|rules, createdAtServerTime,
            scenes: [{ atTrackSec (ascending, first = 0), mode, params, note }] (1..12) }
```
`ScenePlanCoreSchema` (`scenes` only) is the structured-output format handed to the model. The server's scene timer fires
`LEAD_MS` before each boundary, sets `mode`, re-plans with `applyAtServerTime = boundary`, and broadcasts; every phone
ramps its gains at that exact instant. On PLAY / SEEK / a freshly accepted plan the scene at or before the position
becomes the mode immediately. `nextScene` / `currentScene` (`timeline.ts`) are the pure rules; `activeSceneIndex(plan,
trackTimeSec)` is what the host's scene strip highlights. A playlist advance clears the plan (it was written for the
song that ended).

## 10. Mock server

`bun run mock --scenario apps/web/mocks/scenarios/party-12.json` starts `packages/protocol/src/mock-server.ts` on `:8080`
(`PORT`). The whole e2e suite runs against it, so it must behave like `apps/server` wherever a test can tell:
same schemas, same planner, same join / viewer / host-key rules, live latency, scene timer, end-of-track loop and
playlist advance, calibration cancel / reset / failed, `GET /tracks` shape and order.
`bun run packages/protocol/scripts/parity-probe.ts <url>` runs the same black-box probes against either and prints a
JSON object to diff.

Deliberate differences, and only these: one room (the scenario's) with a fixed `hostKey`; seeded `mock-*` players with
synthetic health and fake calibration results; a calibration order that does not yet require `AUDIO_READY` (the stub
engine does not announce it — PROTO-15); a fixed rules-only `/vibe` plan (`UNISON @0 → ORCHESTRA @50 % → WAVE @75 %`);
no upload; no idle TTL or ping timeout; a fixed 2 Hz publish tick; a 1 h audio cache; optional chaos (`restartAfterSec`, drop every socket; with `wipe: true` the room is also re-created empty, as a real restart leaves it).
Scenario files are frontend-owned. The mock serves `fixtures/tracks` on `/audio`.
