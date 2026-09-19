# 02 · Protocol — the contract between server, sync-client and UI

Owner: backend agent (edits), frontend agent (reads; requests changes in [PROTOCOL-REQUESTS.md](PROTOCOL-REQUESTS.md)).

This document mirrors `packages/protocol/src/*.ts`. **The code is the source of truth**; a test
(`packages/protocol/src/__tests__/schemas.test.ts`) fails if the message tables below drift from the
zod unions. Frozen at IC0 (`PROTOCOL_VERSION = 1`); after that, changes are additive and bump the version.

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
inside the assignment, so the UI never adds these numbers itself.

## 2. Units and conventions

- All wire times are **ms floats** on the server clock; durations in ms; track positions in **seconds**.
- Positions: `x, y ∈ [0, 1]`, origin top-left, y down (the Hive Map canvas).
- Gains: dB per stem; `−60 dB` means silent. A non-separated track is a one-stem track named `mix`.
- `role` (`drums | bass | vocals | other | unison`) selects a color from `ROLE_COLORS`; `assignment` is the truth.
- Health colors come only from `healthLevel()`: `good ≤ 5 ms`, `warn ≤ 20 ms`, `bad` above or stale (>5 s), `unknown` without data.
  `syncErrMs := minRttMs/2 + |lastAppliedCorrectionMs|`.
- Identity: the client generates a UUID once, keeps it in `localStorage`, and sends it in `JOIN`; the server keeps a
  disconnected record for `DISCONNECT_RETENTION_MS = 120 000` so a reconnect restores the same `joinIndex`, position and assignment.
- Rates: `ROOM_STATE` ≤ 2 Hz (coalesced, always a full snapshot); `HEALTH` 1 Hz to hosts only; `CLIENT_STATUS` every 2 s;
  `SET_POSITION` throttled to 10 Hz by the UI; `PING` every 20 s.

## 3. Clock sync (NTP-style over the room WebSocket)

Ported from Beatsync's `ntp.ts`. Four timestamps per probe: `t0` client send, `t1` server receive, `t2` server send, `t3` client receive.

```
offset = ((t1 − t0) + (t2 − t3)) / 2        rtt = (t3 − t0) − (t2 − t1)
```

Schedule: a burst of 20 probes over 4 s at connect, then 1 Hz forever. Coded probe **pairs** (`probeGroupId`, `probeGroupIndex 0|1`)
sent 10 ms apart: a pair whose server-side inter-arrival differs from 10 ms by more than 2 ms is discarded (queueing).
Selection: the **minimum-RTT** probe within a sliding window of 30 keeps the offset; corrections are slewed, never stepped,
except the hard resync in §7. Budget: ±2–5 ms on Wi-Fi.

## 4. Messages: client → server

Discriminated on `type`. Host-only messages return `ERROR NOT_HOST` from a player.

| `type` | fields | who | notes |
|---|---|---|---|
| `JOIN` | `clientId, roomCode, kind: host\|player, plays, hostKey?, name?, device{userAgent, platform, browserFamily, model?}, protocolVersion` | any | first message on the socket; `kind: host` needs a valid `hostKey` unless the id is already a host |
| `NTP_REQUEST` | `t0, probeGroupId?, probeGroupIndex?` | any | answered immediately with `NTP_RESPONSE` |
| `SET_TRACK` | `trackId` | host | loads the track into the room; phones preload **all stems** and answer `AUDIO_READY` |
| `TRANSPORT` | `action: PLAY\|PAUSE\|SEEK, trackTimeSec?` | host | see §1 |
| `SET_MODE` | `mode, params` | host | clears `scenePlan` (manual override wins) and re-plans |
| `ASSIGN` | `clientId, role\|null` | host | pin / unpin a player's stem |
| `SET_POSITION` | `clientId, x, y` | host | Hive Map drag; UI throttles to 10 Hz |
| `NUDGE` | `clientId, nudgeMs ∈ [−100, 100]` | host or self | folds into `compensationMs` |
| `SET_PLAYS` | `plays` | host | "use this phone as a speaker too" |
| `KICK` | `clientId` | host | removes the client |
| `AUDIO_READY` | `trackId` | any | all stems decoded for that track |
| `CLIENT_STATUS` | `rttMs, syncErrMs, outputLatencyMs, audioState` | any | every 2 s; feeds `HEALTH` |
| `CALIBRATION_START` | `referenceClientId` | host | the host phone is the listener; see [04-calibration.md](04-calibration.md) |
| `CALIBRATION_REPORT` | `measurements[{clientId, residualMs, confidence}]` | reference | server accumulates `calibratedOffsetMs` |
| `PONG` | – | any | liveness reply to `PING` |

## 5. Messages: server → client

| `type` | fields | to | notes |
|---|---|---|---|
| `WELCOME` | `clientId, roomCode, serverTime, protocolVersion, isHost` | joiner | a stale cached bundle compares `protocolVersion` and reloads |
| `NTP_RESPONSE` | `t0, t1, t2, probeGroupId?, probeGroupIndex?` | prober | |
| `ROOM_STATE` | `room` (full `RoomState`) | room | on any change, coalesced to ≤2 Hz; the joiner gets one immediately |
| `HEALTH` | `serverTime, clients{[id]: {rttMs, syncErrMs, outputLatencyMs, audioState, lastSeenServerTime}}` | hosts | 1 Hz |
| `SCHEDULED_ACTION` | `serverTimeToExecute, action{kind: CALIBRATION_CLICK, clickId, clickSpec}` | one player | the only scheduled action left; phones synthesize the click |
| `CALIBRATION_PLAN` | `startServerTime, intervalMs, order[], clickSpec` | reference | which phone clicks when |
| `PING` | `serverTime` | room | every 20 s |
| `ERROR` | `code, message` | one | `BAD_MESSAGE, NO_ROOM, NOT_HOST, NO_TRACK, KICKED` |

## 6. REST

| route | body → response |
|---|---|
| `GET /health` | `{ok, protocolVersion, serverTime}` |
| `POST /rooms` | `{code?}` → `{code, hostKey, joinUrl}` — a fixed code (`ROOM_FIXED_CODE`) survives a restart |
| `GET /rooms/:code` | `{code, exists, players}` |
| `GET /tracks?q=` | `{tracks: TrackLibraryEntry[]}` — library search over `fixtures/tracks/*/meta.json`; each entry carries `urls{stem→wav}`, `energy[]`, `clickTimesSec[]` |
| `GET /audio/:trackId/:stem.wav` | 16-bit mono 44.1 kHz WAV, `Cache-Control: public` |
| `POST /rooms/:code/vibe` | `{prompt}` → `{scenePlan}` (LLM or rules fallback; see [05-effect-modes.md](05-effect-modes.md)) |
| `POST /tracks` | upload → Replicate Demucs — **stretch**, not on the demo path |

CORS: `Access-Control-Allow-Origin` = `CORS_ORIGIN` (the Vercel origin) on every route.

## 7. RoomState (what `ROOM_STATE` carries)

```ts
RoomState {
  code, protocolVersion, createdAtServerTime, hostClientIds: string[],
  track: { id, title, durationSec, stems: string[], bpm? } | null,
  transport: Transport,                       // §1
  mode: { kind: UNISON|ORCHESTRA|STEREO|WAVE|STROBE, params: ModeParams },
  scenePlan: ScenePlan | null,                // Vibe Director output, §9
  calibration: { state: idle|countdown|running|done|failed, referenceClientId, startServerTime, order[], results{[id]: {residualMs, confidence}} },
  clients: { [id]: ClientRecord }
}
ClientRecord {
  id, kind: host|player, plays, name, device, joinIndex, joinedAtServerTime,
  position: {x, y} | null, pinnedRole: drums|bass|vocals|other | null,
  nudgeMs, tableLatencyMs | null, calibratedOffsetMs | null,
  assignment: Assignment | null,              // null for a non-playing host
  connected, audioReadyTrackId | null
}
Assignment {
  label, role, color, gainsDb: { [stem]: dB }, delayMs, compensationMs,
  pattern: { kind: strobe|wave, periodMs, phaseMs, duty?, rampMs? } | null,
  applyAtServerTime: number | null            // scene boundaries: apply exactly then
}
```

Invariants the UI may rely on:

1. Every snapshot is complete; render from it and never diff against earlier snapshots.
2. `assignment` is the pure output of `plan(room)` (`packages/protocol/src/planner.ts`), shared by the real server and the mock:
   stable under joins (`joinIndex % stems`), pins win, non-playing hosts get `null`, `UNISON` = every stem at 0 dB.
3. Mode switches are **gain changes**, never reloads: phones hold all stems decoded from `SET_TRACK` on.
4. Patterns are evaluated client-side with `evaluatePattern(pattern, trackTimeMs)` on the shared clock — no per-tick messages.
5. `clients[id].position === null` means "not placed yet"; the planner treats it as the middle of the axis.

## 8. Sync-health, colors, constants

`ROLE_COLORS`, `HEALTH_COLORS`, `healthLevel()`, `LEAD_MS`, the NTP schedule, the rate caps and the starter latency table all live
in `packages/protocol/src/constants.ts` / `health.ts`. Docs quote them; code defines them.

## 9. Vibe Director data

```ts
ScenePlan { prompt, source: llm|rules, createdAtServerTime,
            scenes: [{ atTrackSec (ascending, first = 0), mode, params, note }] (1..12) }
```
`ScenePlanCoreSchema` (`scenes` only) is the structured-output format handed to the model. The server's scene timer fires
`LEAD_MS` before each boundary, sets `mode`, re-plans with `applyAtServerTime = boundary`, and broadcasts; every phone
ramps its gains at that exact instant. `activeSceneIndex(plan, trackTimeSec)` is what the host's scene strip highlights.

## 10. Mock server

`bun run mock --scenario apps/web/mocks/scenarios/party-12.json` starts `packages/protocol/src/mock-server.ts` on `:8080`
with the same routes and schemas, seeded players, synthetic health, a simulated tuning moment, a rules-only `/vibe`, and
optional chaos (`restartAfterSec`). Scenario files are frontend-owned. The mock serves `fixtures/tracks` on `/audio`.
