# HiveMusic — Architecture

Owner: both

One Bun server owns the timeline and the room. One Next.js app renders host and player screens. One headless engine (`@hive/sync-client`) does every clock, audio and WebSocket thing in the browser. One shared package (`@hive/protocol`) holds the contract and the pure planning functions that both the real server and the mock server run. Read [00-context.md](00-context.md) first; the wire contract is [02-protocol.md](02-protocol.md) and the code under `packages/protocol/src/` is its source of truth.

## Components

| Component | Lives in | Owner | Responsibility |
|---|---|---|---|
| Host UI | `apps/web` routes `/`, `/h/[code]`, `/diag` | frontend | Lobby (code, QR of `joinUrl`, speaker toggle, library search, track select, Start), Stage (transport, mode chips, vibe box + scene strip, Hive Map, player sheet), Calibrate, Players drawer — spec in [06](06-hive-map-ui.md) |
| Player PWA | `apps/web` routes `/j/[code]`, `/diag` | frontend | Join (name, tap-to-unlock, ringer banner), Ready (sync ring, stem progress, part preview), Playing (role colour, pulse, nudge, mute), Calibrating; `public/manifest.webmanifest`, no service worker |
| Session/sync server | `apps/server` | backend | Rooms in memory; `JOIN`/`WELCOME`; NTP responder; coalesced `ROOM_STATE` (≤2 Hz); `HEALTH` (1 Hz, hosts only); `SET_TRACK`/`TRANSPORT`; planner execution; scene timer; calibration orchestration; REST (`/health`, `/rooms`, `/rooms/:code`, `/tracks`, `/audio`, `/rooms/:code/vibe`) with CORS |
| Sync engine | `packages/sync-client` | backend | Everything browser-side that is not UI: WebSocket + reconnect, clock model, AudioContext, stem preload, scheduling, drift resync, pattern gain automation, calibration click emit/listen, wake lock, device detection. `src/index.ts` is the frozen surface; `src/stub.ts` (`createStubClient`) speaks the real protocol with no audio |
| Contract + planner | `packages/protocol` | backend (v1 written before the agents start) | `constants`, `messages`, `room`, `mode`, `pattern`, `health`, `scene`, `rest`, `planner`, `mock-server` + `__tests__/` |
| Audio fixtures | `fixtures/` | backend | `gen-synthetic.ts` → `fixtures/tracks/synthetic-60s/{drums,bass,vocals,other}.wav` + `meta.json` (`energy[60]`, `clickTimesSec`, `dropSec`, `bpm`); demo tracks in the same layout |
| Vibe service | `apps/server/src/vibe/` | backend | One `messages.parse` call with `zodOutputFormat(ScenePlanCoreSchema)`; `rules.ts` fallback; scene timer |
| Infra | `infra/` | backend | `fly.toml` (app `hivemusic-server`, `ewr` (Newark; Fly retired `bos`), always-on, `/health` checks), `Dockerfile` |

## Package graph

```
                 ┌──────────────────────────────────┐
                 │  @hive/protocol                  │  packages/protocol
                 │  constants · messages · room     │  zod schemas + pure functions
                 │  mode · pattern · health · scene │  + mock-server (runs the same planner)
                 │  rest · planner                  │
                 └──────┬───────────────────┬───────┘
                        │                   │
            ┌───────────▼─────────┐   ┌─────▼──────────────┐
            │ @hive/sync-client   │   │ apps/server         │
            │ packages/sync-client│   │ Bun.serve WS + REST │
            │ createHiveClient()  │   └────────────────────┘
            │ createStubClient()  │
            └───────────┬─────────┘
                        │
              ┌─────────▼──────────┐
              │ apps/web (Next.js) │  imports ONLY @hive/protocol + @hive/sync-client;
              │ lib/useHiveClient  │  never creates its own AudioContext or WebSocket
              └────────────────────┘
```

Rules (`agents/SHARED-RULES.md`): nothing imports from `apps/*`; `apps/web` imports only the two packages; `apps/server` imports `@hive/protocol` only. The mock server (`packages/protocol/src/mock-server.ts`, `bun run mock`) runs the same `plan(room)` and schemas as the real server, so the frontend sees real assignments before B5 lands; the stub client gives it real `WELCOME`/NTP/`ROOM_STATE` plumbing before B2 lands.

## Ownership matrix

| Path | Owner | Others may |
|---|---|---|
| `apps/server/**` | backend | read |
| `packages/protocol/**` | backend (frozen at IC0; additive-only after) | read, import; request changes via [PROTOCOL-REQUESTS.md](PROTOCOL-REQUESTS.md) |
| `packages/sync-client/**` | backend | read, import; request changes the same way |
| `fixtures/**`, `infra/**` | backend | read; run `bun run fixtures` |
| `apps/web/**` (incl. `apps/web/mocks/scenarios/*.json`) | frontend | read |
| `docs/**` | set up before the agents start | append to `PROTOCOL-REQUESTS.md`; update own rows in the [08-roadmap.md](08-roadmap.md) status table |
| `agents/<AGENT>-AGENT.md` | that agent | update its own gate table only |
| root config, `.github/**`, `README.md`, `CLAUDE.md` | setup | propose in `PROTOCOL-REQUESTS.md`; the human decides |
| `evidence/backend/**` / `evidence/frontend/**` | backend / frontend | — |

Branches: `agent/backend`, `agent/frontend`, branched from `main` at IC0; rebase on `origin/main` before every gate; PR to `main` at each checkpoint (the human merges); never rewrite the other branch. Root must be green (`bun run typecheck && bun run test`) before any merge; CI (`.github/workflows/ci.yml`: install → fixtures → typecheck → test) enforces it.

## Data flows

Message names and fields are exact ([02-protocol.md](02-protocol.md) §4–6 is the contract).

### Join

| # | From → To | Message / call | Notes |
|---|---|---|---|
| 1 | host → server | `POST /rooms {code?}` → `{code, hostKey, joinUrl}` | `code` may be the fixed demo code (`ROOM_FIXED_CODE`, `BZQ7` in `.env.example`); `hostKey` kept in localStorage per code |
| 2 | host → server | WS `JOIN {clientId, roomCode, kind:'host', plays:false, hostKey, name?, device, protocolVersion}` | `clientId` is a UUID persisted in localStorage (`hive:clientId:<code>`) |
| 3 | server → host | `WELCOME {clientId, roomCode, serverTime, protocolVersion, isHost}`, then `ROOM_STATE` immediately | |
| 4 | host → server | `SET_TRACK {trackId}` after choosing from `GET /tracks?q=` | sets `room.track`, `transport` → `stopped`; phones start preloading |
| 5 | player → server | `JOIN {clientId, roomCode, kind:'player', plays:true, name, device, protocolVersion}` | sent after "Tap to join" unlocked audio; `tableLatencyMs` is set from `device.browserFamily` |
| 6 | server → player | `WELCOME`, then `ROOM_STATE` (≤2 Hz, coalesced, always a full snapshot) | `clients[id].assignment` present for every speaker |
| 7 | player ↔ server | `NTP_REQUEST {t0, probeGroupId?, probeGroupIndex?}` / `NTP_RESPONSE {t0, t1, t2, probeGroupId?, probeGroupIndex?}` | 20 coded pairs in 4 s, then 1 Hz — [03](03-sync-engine.md) |
| 8 | player → server | `GET /audio/:trackId/:stem.wav` for every stem in `room.track.stems`, decode, then `AUDIO_READY {trackId}` | server sets `clients[id].audioReadyTrackId`; Lobby's Start waits for it |
| 9 | player → server | `CLIENT_STATUS {rttMs, syncErrMs, outputLatencyMs, audioState}` every 2 s; `PONG` to each `PING` | feeds `HEALTH {serverTime, clients}` to hosts at 1 Hz |
| 10 | server | disconnect → `connected:false`, record kept 120 s; a `JOIN` with the same `clientId` resumes it (same `joinIndex`, nudge, calibration, position) | restart recovery ≤5 s |

### Play / pause / seek

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `TRANSPORT {action:'PLAY', trackTimeSec?}` | `ERROR NO_TRACK` if no `SET_TRACK` yet |
| 2 | server | `transport = {state:'playing', serverTimeAtTrackZero: now + LEAD_MS − from·1000}` with `from = trackTimeSec ?? (paused ? trackTimeAtPause : 0)`, `LEAD_MS = 600` | one timeline source of truth |
| 3 | server → all | `ROOM_STATE {room}` | every phone derives its own start time from `transport` — [03](03-sync-engine.md) |
| 4 | host → server | `TRANSPORT {action:'PAUSE'}` → `transport = {state:'paused', trackTimeAtPause}` | phones stop on receipt |
| 5 | host → server | `TRANSPORT {action:'SEEK', trackTimeSec}` or `PLAY` from paused | both are a new PLAY with a new `serverTimeAtTrackZero` |

### Mode switch and host edits

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `SET_MODE {mode, params}` | sets `room.mode`, clears `scenePlan` |
| 2 | server | `withAssignments(room)` → new `clients[id].assignment` for every speaker | gains/delay/pattern only; no reloads |
| 3 | server → all | `ROOM_STATE` | phones ramp gains to the new `gainsDb` (at `applyAtServerTime` if set, else now) |
| — | host → server | `ASSIGN {clientId, role\|null}` / `SET_POSITION {clientId, x, y}` (engine-throttled to 10 Hz) / `NUDGE {clientId, nudgeMs}` / `SET_PLAYS {plays}` / `KICK {clientId}` | each re-plans and broadcasts the same way; `NUDGE` is also accepted from a player for itself (`nudgeSelf`) |

### Calibration (Tier 2)

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `CALIBRATION_START {referenceClientId}` | reference = the host phone |
| 2 | server | `room.calibration = {state:'countdown', referenceClientId, startServerTime: now + 3000, order, results:{}}` | `order` = speakers except the reference, by `joinIndex` |
| 3 | server → reference | `CALIBRATION_PLAN {startServerTime, intervalMs: 400, order, clickSpec}` | |
| 4 | server → each player k | `SCHEDULED_ACTION {serverTimeToExecute: startServerTime + k·400, action:{kind:'CALIBRATION_CLICK', clickId, clickSpec}}` | the engine emits `calibrationClick` for the screen flash |
| 5 | reference | `calibration.runAsReference()` records via `getUserMedia`, cross-correlates, computes a residual per player | [04-calibration.md](04-calibration.md) |
| 6 | reference → server | `CALIBRATION_REPORT {measurements:[{clientId, residualMs, confidence}]}` | |
| 7 | server | `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs ?? 0) + residualMs`; `calibration.results[id]`; `state:'done'`; re-plan; `ROOM_STATE` | reference calls `track.stop()` |

### Vibe

| # | From → To | Message | Notes |
|---|---|---|---|
| 1 | host → server | `POST /rooms/:code/vibe {prompt}` (≤500 chars) | |
| 2 | server → Claude | `messages.parse` with `zodOutputFormat(ScenePlanCoreSchema)`, model `VIBE_MODEL` (default `claude-sonnet-5`), 5 s timeout | `parsed_output === null` / no key / refusal / timeout → `rules.ts` |
| 3 | server → host | `{scenePlan}` with `source: 'llm' \| 'rules'`; `room.scenePlan` set; `ROOM_STATE` | scene strip renders from `room.scenePlan.scenes`, current via `activeSceneIndex` |
| 4 | server (scene timer) | `LEAD_MS` before each `atTrackSec`: set mode, `withAssignments(room, boundary)` so every `assignment.applyAtServerTime = serverTimeAtTrackZero + atTrackSec·1000`, broadcast | all phones ramp together |

## Session state model

`RoomState` (`packages/protocol/src/room.ts`; [02-protocol.md](02-protocol.md) §7):

```
room
├── code, protocolVersion, createdAtServerTime, hostClientIds[]
├── track { id, title, durationSec, stems[], bpm? } | null
├── transport  stopped {} | playing { serverTimeAtTrackZero } | paused { trackTimeAtPause }
├── mode { kind, params }
├── scenePlan { prompt, source, createdAtServerTime, scenes[] } | null
├── calibration { state: idle|countdown|running|done|failed, referenceClientId, startServerTime, order[], results{} }
└── clients[id] { id, kind, plays, name, device, joinIndex, joinedAtServerTime, position|null,
                 pinnedRole|null, nudgeMs, tableLatencyMs|null, calibratedOffsetMs|null,
                 assignment|null, connected, audioReadyTrackId|null }
```

Server-only state (never on the wire): `hostKey`; per-client health record (`HealthSnapshot` from `CLIENT_STATUS` + `lastSeenServerTime` from `PONG`); the socket map; the `ROOM_STATE` dirty flag and its `1000 / ROOM_STATE_MAX_HZ` flush timer; the scene timer; the calibration timers. Fan-out: `ws.subscribe(room.code)` on join and `server.publish(room.code, …)` for `ROOM_STATE`/`PING`; `HEALTH` is sent directly to each host socket (as the mock does). Rooms with no clients expire after `ROOM_IDLE_TTL_MS`.

## Design changes and why

| Change (from the plan) | Why |
|---|---|
| **One timeline source of truth** — `transport.{state, serverTimeAtTrackZero, trackTimeAtPause}` in `ROOM_STATE`; no scheduled PLAY/PAUSE actions; `SCHEDULED_ACTION` survives only for `CALIBRATION_CLICK` | Late join, reconnect, tab resume and first play are one code path: "given `transport` and my clock, where should I be?" A second mechanism is a second way to disagree. |
| **Every phone preloads all stems** (≤4 mono 16-bit WAV, ≤60 s ≈ 42 MB decoded) from `SET_TRACK` on; an assignment is `{gainsDb per stem, delayMs, pattern, …}`; mode switches are gain ramps, never reloads | A switch that needs a network fetch cannot land on a beat. Gains ramp on the shared clock in the same instant on every phone. |
| **WAV stems** | MP3/AAC decoder priming differs per browser by up to ~25 ms — more than the whole sync target. |
| **UNISON = all stems at 0 dB; a non-stem track is a one-stem track named `mix`** | Demucs stems sum ≈ the mix, so unison needs no separate asset and every mode has one code path. |
| **STEREO = zone-based stem grouping** (left drums+bass, right vocals+other) | Stems are mono; a true L/R split needs a stereo mix asset (stretch). Zones still read as "wide". |
| **Assignment lives in `clients[id].assignment`** inside `ROOM_STATE`; no separate unicast | Nothing to reconcile with the snapshot; the map draws from the object the phone plays from. Hosts with `plays:false` get `null` and are drawn hollow. |
| **One compensation number per phone, server-side** — `compensationMs = nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0)` | The host UI shows one number per phone; the client formula stays trivial and testable. |
| **Planner and pattern evaluation are pure functions in `@hive/protocol`** | Real server and mock produce identical assignments; the frontend builds against the truth from hour one. |
| **Stable planner** (`joinIndex % stems`, no reshuffle on join, `pinnedRole` wins) | A phone changing colour because someone else joined looks like a bug on the map. |
| **Traffic caps** (`ROOM_STATE` ≤2 Hz, `HEALTH` 1 Hz hosts-only, `SET_POSITION` throttled to 10 Hz inside the engine) | Sixty phones on a hotspot; dragging a dot must not flood the room. |
| **Identity = client UUID in localStorage; 120 s retention; fixed demo code; `WELCOME` carries `protocolVersion`** | Reload, lock screen and server restart all rejoin as the same person with the same assignment; a stale bundle is detected on the first message. |
| **Drift v1 = hard resync + 20 ms crossfade when error >10 ms** | Simple, testable, and the same check covers `interrupted`/visibility resume; `playbackRate` slewing is stretch. |
| **No service worker; manifest only** | A stale cache during a live demo is unrecoverable from the stage. |
| **Calibration rig first** | The cross-correlation code is the measuring instrument for B3/B4 before it becomes the B8 feature. |

## Hosting

```
  phones (one Wi-Fi / hotspot)                     cloud
  ┌──────────────┐                            ┌───────────────────────────────┐
  │ host phone   │── HTTPS (pages) ──────────▶│ Vercel · apps/web             │
  │ player phones│                            └───────────────────────────────┘
  │              │── WSS /ws + HTTPS REST ───▶┌───────────────────────────────┐
  │              │   GET /audio/*.wav (CORS)  │ Fly.io ewr · hivemusic-server │
  └──────────────┘                            │ always-on, 1 machine,         │
                                              │ PING every 20 s, /health 15 s │
                                              └───────────────────────────────┘
```

Phone-to-`ewr` (Newark; Fly retired `bos`) RTT of 10–40 ms over Wi-Fi is fine: NTP cancels symmetric latency. What breaks the ≤10 ms target is asymmetric latency (cellular), hence one Wi-Fi/hotspot for every phone in the demo. CORS allows the Vercel origin (`CORS_ORIGIN`). Configuration is in [07-tech-stack.md](07-tech-stack.md); rooms live in memory, so exactly one machine runs.
