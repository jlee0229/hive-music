# HiveMusic — Architecture

Owner: both

One Bun server owns the timeline and the room. One Next.js app renders host and player screens. One headless engine (`@hive/sync-client`) does every clock, audio and WebSocket thing in the browser. One shared package (`@hive/protocol`) holds the contract and the pure planning functions that both the real server and the mock server run. Read [00-context.md](00-context.md) first; the wire contract is [02-protocol.md](02-protocol.md).

## Components

| Component | Lives in | Owner | Responsibility |
|---|---|---|---|
| Host UI | `apps/web` routes `/`, `/h/[code]`, `/diag` | frontend | Lobby (code, QR, speaker toggle, library search, Start), Stage (transport, mode chips, vibe box + scene strip, Hive Map), Calibrate, Players drawer |
| Player PWA | `apps/web` routes `/j/[code]`, `/diag` | frontend | Join (name, tap-to-unlock, stem progress, ringer banner), Ready, Playing (role colour, nudge, mute), Calibrating; web manifest, no service worker |
| Session/sync server | `apps/server` | backend | Rooms in memory; `JOIN`/`WELCOME`; NTP responder; coalesced `ROOM_STATE` (≤2 Hz); `HEALTH` (1 Hz, hosts only); transport; planner execution; scene timer; calibration orchestration; REST (`/rooms`, `/tracks`, `/audio`, `/rooms/:code/vibe`, `/health`) with CORS |
| Sync engine | `packages/sync-client` | backend | Everything browser-side that is not UI: WebSocket + reconnect, clock model, AudioContext, stem preload, scheduling, drift resync, pattern gain automation, calibration click emit/listen, device detection |
| Contract + planner | `packages/protocol` | backend (v1 written before the agents start) | zod message schemas, `RoomState`, `Assignment`, constants, `plan(room)`, `evaluatePattern`, `healthLevel`, `ROLE_COLORS`, `ScenePlanSchema`, mock server |
| Audio fixtures | `fixtures/` | backend | `gen-synthetic.ts` → `synthetic-60s/{drums,bass,vocals,other}.wav` + `meta.json` (`energy[]` per second, click times); demo tracks in the same layout |
| Vibe service | `apps/server/src/vibe/` | backend | One `messages.parse` call with `zodOutputFormat(ScenePlanSchema)`; `rules.ts` fallback; scene timer |
| Infra | `infra/` | backend | `fly.toml`, `Dockerfile` (always-on, `bos`) |

## Package graph

```
                 ┌──────────────────────────────┐
                 │  @hive/protocol              │  packages/protocol
                 │  messages · room · assignment│  zod schemas + pure functions
                 │  constants · planner         │  + mock-server (runs the same planner)
                 │  pattern · health · scene    │
                 └──────┬───────────────┬───────┘
                        │               │
            ┌───────────▼─────────┐   ┌─▼──────────────────┐
            │ @hive/sync-client   │   │ apps/server         │
            │ packages/sync-client│   │ Bun.serve WS + REST │
            │ createHiveClient()  │   └────────────────────┘
            └───────────┬─────────┘
                        │
              ┌─────────▼──────────┐
              │ apps/web (Next.js) │  imports ONLY @hive/protocol + @hive/sync-client;
              │ useHiveClient hook │  never creates its own AudioContext or WebSocket
              └────────────────────┘
```

Rules (from `agents/SHARED-RULES.md`): nothing imports from `apps/*`; `apps/web` imports only the two packages; the mock server inside `@hive/protocol` runs the same `plan(room)` as the real server, so the frontend sees real assignments before B5 lands.

## Ownership matrix

| Path | Owner | Others may |
|---|---|---|
| `apps/server/**` | backend | read |
| `packages/protocol/**` | backend (frozen at IC0; additive-only after) | read; request changes via [PROTOCOL-REQUESTS.md](PROTOCOL-REQUESTS.md) |
| `packages/sync-client/**` | backend | read |
| `fixtures/**`, `infra/**` | backend | read |
| `apps/web/**` (incl. `mocks/scenarios/*.json`) | frontend | read |
| `docs/**`, root config, `agents/**` | set up before the agents start | append to `PROTOCOL-REQUESTS.md`; update own gate rows in [08-roadmap.md](08-roadmap.md) |
| `evidence/backend/**` | backend | — |
| `evidence/frontend/**` | frontend | — |

Branches: `agent/backend`, `agent/frontend`; merge to `main` only at checkpoints via PR; rebase before each gate; never rewrite the other branch. Root must be green (`bun run typecheck && bun test`) before any merge; CI enforces it.

## Data flows

Message names are exact; field lists are abbreviated — [02-protocol.md](02-protocol.md) is the contract.

### Join

| # | From → To | Message / call | Notes |
|---|---|---|---|
| 1 | host → server | `POST /rooms {code?}` → `{code, hostKey}` | `code` may be the fixed demo code (`ROOM_FIXED_CODE`) |
| 2 | host → server | WS `JOIN {clientId, roomCode, kind:'host', plays:false, hostKey, device}` | `clientId` is a UUID persisted in localStorage |
| 3 | server → host | `WELCOME {clientId, roomCode, serverTime, protocolVersion, isHost}`, then `ROOM_STATE` | |
| 4 | player → server | `JOIN {clientId, roomCode, kind:'player', plays:true, name, device}` | sent after "Tap to join" unlocked audio |
| 5 | server → player | `WELCOME`, then `ROOM_STATE` (≤2 Hz, coalesced) | `clients[id].assignment` present once the planner covers this client |
| 6 | player ↔ server | `NTP_REQUEST {t0, probeGroupId?, probeGroupIndex?}` / `NTP_RESPONSE {t0, t1, t2, …}` | 20 probes in 4 s, then 1 Hz — [03](03-sync-engine.md) |
| 7 | player → server | `GET /audio/:trackId/:stem.wav` for every stem, decode, then `AUDIO_READY {trackId}` | |
| 8 | player → server | `CLIENT_STATUS {rttMs, syncErrMs, outputLatencyMs, audioState}` every 2 s | feeds `HEALTH` to hosts at 1 Hz |
| 9 | server | disconnect → record kept 120 s; a `JOIN` with the same `clientId` resumes it (same `joinIndex`, nudge, calibration) | restart recovery ≤5 s |

### Play / pause / seek

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `TRANSPORT {action:'PLAY', trackId?, trackTimeSec?}` | |
| 2 | server | `transport = {state:'playing', serverTimeAtTrackZero: now + LEAD_MS − trackTimeSec·1000}`, `LEAD_MS = 600` | one timeline source of truth |
| 3 | server → all | `ROOM_STATE {room}` | every phone derives its own start time from `transport` — [03](03-sync-engine.md) |
| 4 | host → server | `TRANSPORT {action:'PAUSE'}` → `transport = {state:'paused', trackTimeAtPause}` | clients stop sources |
| 5 | host → server | `TRANSPORT {action:'SEEK', trackTimeSec}` or resume | server treats it as a new PLAY (new `serverTimeAtTrackZero`) |

### Mode switch and host edits

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `SET_MODE {mode, params}` | clears `scenePlan` |
| 2 | server | `room.mode = …; plan(room)` → new `clients[id].assignment` | gains/delay/pattern only; no reloads |
| 3 | server → all | `ROOM_STATE` | clients ramp gains to the new `gainsDb` (at `applyAtServerTime` if present, else now) |
| — | host → server | `ASSIGN {clientId, role\|null}` / `SET_POSITION {clientId, x, y}` (≤10 Hz) / `NUDGE {clientId, nudgeMs}` / `SET_PLAYS {plays}` | each re-plans and broadcasts the same way |

### Calibration (Tier 2)

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `CALIBRATION_START {referenceClientId}` | reference = the host phone |
| 2 | server → reference | `CALIBRATION_PLAN {startServerTime, intervalMs: 400, order:[clientId…], clickSpec}` | |
| 3 | server → each player | `SCHEDULED_ACTION {serverTimeToExecute, action:{type:'CALIBRATION_CLICK', clickId}}` | player k fires at `startServerTime + k·400` |
| 4 | reference | records via `getUserMedia`, cross-correlates, computes a residual per player | [04-calibration.md](04-calibration.md) |
| 5 | reference → server | `CALIBRATION_REPORT {measurements:[{clientId, residualMs, confidence}]}` | |
| 6 | server | `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs) + residualMs`; re-plan; `ROOM_STATE` | reference calls `track.stop()` |

### Vibe

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `POST /rooms/:code/vibe {prompt}` | |
| 2 | server → Claude | `messages.parse` with `zodOutputFormat(ScenePlanSchema)`, model `VIBE_MODEL` (default `claude-sonnet-5`), 5 s timeout | `parsed_output === null` / no key / refusal / timeout → `rules.ts` |
| 3 | server → host | `{scenePlan}`; `room.scenePlan` set; `ROOM_STATE` | scene strip renders from `room.scenePlan` |
| 4 | server (scene timer) | `LEAD_MS` before each `atTrackSec`: set mode, re-plan, broadcast with `assignment.applyAtServerTime = serverTimeAtTrackZero + atTrackSec·1000` | all phones ramp together |

## Session state model

`RoomState` (exact shape in [02-protocol.md](02-protocol.md)):

```
room
├── code, protocolVersion, hostClientIds[]
├── track { id, title, durationSec, stems[] }
├── transport { state, serverTimeAtTrackZero, trackTimeAtPause }
├── mode { kind, params }
├── scenePlan | null
└── clients[id] { id, kind, plays, name, device, joinIndex, position|null,
                 pinnedRole|null, nudgeMs, tableLatencyMs|null,
                 calibratedOffsetMs|null, assignment|null, connected }
```

Server-only state (never on the wire): `hostKey`; per-client health record (from `CLIENT_STATUS`, plus `lastSeen` and `audioReady`); the `ROOM_STATE` coalescing timer; the scene timer; the in-flight calibration session; disconnect timestamps (records deleted after 120 s). Fan-out uses `server.publish('room:<code>', …)` for everyone and `server.publish('hosts:<code>', …)` for `HEALTH` (assumption on topic names).

## Design changes and why

| Change (from the plan) | Why |
|---|---|
| **One timeline source of truth** — `transport.{state, serverTimeAtTrackZero, trackTimeAtPause}` in `ROOM_STATE`; no scheduled PLAY/PAUSE actions; `SCHEDULED_ACTION` survives only for `CALIBRATION_CLICK` | Late join, reconnect, tab resume and first play are one code path: "given `transport` and my clock, where should I be?" A second mechanism is a second way to disagree. |
| **Every phone preloads all stems** (≤4 mono 16-bit WAV, ≤60 s ≈ 42 MB decoded); an assignment is `{gainsDb per stem, delayMs, color, label, pattern?, applyAtServerTime?}`; mode switches are gain ramps, never reloads | A switch that needs a network fetch cannot land on a beat. Gains ramp on the shared clock in the same instant on every phone. |
| **WAV stems** | MP3/AAC decoder priming differs per browser by up to ~25 ms — more than the whole sync target. |
| **UNISON = all stems at 0 dB; a non-stem track is a one-stem track named `mix`** | Demucs stems sum ≈ the mix, so unison needs no separate asset and every mode has one code path. |
| **STEREO = zone-based stem grouping** (left drums+bass, right vocals+other) | Stems are mono; a true L/R split needs a stereo mix asset (stretch). Zones still read as "wide". |
| **Assignment lives in `clients[id].assignment`** inside `ROOM_STATE`; no separate unicast | Nothing to reconcile with the snapshot; the map draws from the object the phone plays from. Hosts with `plays:false` get no assignment and are drawn hollow. |
| **One compensation number per phone, server-side** — `compensationMs = nudgeMs + (calibratedOffsetMs ?? tableLatencyMs)` | The host UI shows one number per phone; the client formula stays trivial and testable. |
| **Planner and pattern evaluation are pure functions in `@hive/protocol`** | Real server and mock produce identical assignments; the frontend builds against the truth from hour one. |
| **Stable planner** (`joinIndex % stems.length`, no reshuffle on join, `pinnedRole` wins) | A phone changing colour because someone else joined looks like a bug on the map. |
| **Traffic caps** (`ROOM_STATE` ≤2 Hz, `HEALTH` 1 Hz hosts-only, `SET_POSITION` throttled to 10 Hz by the UI) | Twenty phones on a hotspot; dragging a dot must not flood the room. |
| **Identity = client UUID in localStorage; 120 s retention; fixed demo code; `WELCOME` carries `protocolVersion`** | Reload, lock screen and server restart all rejoin as the same person with the same assignment; a stale bundle is detected on the first message. |
| **Drift v1 = hard resync + 20 ms crossfade when error >10 ms** | Simple, testable, and the same check covers `interrupted`/visibility resume; `playbackRate` slewing is stretch. |
| **No service worker; manifest only** | A stale cache during a live demo is unrecoverable from the stage. |
| **Calibration rig first** | The cross-correlation code is the measuring instrument for B3/B4 before it becomes the B8 feature. |

## Hosting

```
  phones (one Wi-Fi / hotspot)                     cloud
  ┌──────────────┐                            ┌──────────────────────────┐
  │ host phone   │── HTTPS (pages) ──────────▶│ Vercel · apps/web        │
  │ player phones│                            └──────────────────────────┘
  │              │── WSS /ws + HTTPS REST ───▶┌──────────────────────────┐
  │              │   GET /audio/*.wav (CORS)  │ Fly.io bos · apps/server │
  └──────────────┘                            │ always-on, 1 machine,    │
                                              │ 20 s app-level heartbeat │
                                              └──────────────────────────┘
```

Phone-to-`bos` RTT of 10–40 ms over Wi-Fi is fine: NTP cancels symmetric latency. What breaks the ≤10 ms target is asymmetric latency (cellular), hence one Wi-Fi/hotspot for every phone in the demo. Configuration is in [07-tech-stack.md](07-tech-stack.md); rooms live in memory, so exactly one machine runs.
