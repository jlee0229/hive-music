# Backend agent brief — server, protocol, sync engine

**Model:** Claude Opus 5. **Branch:** `agent/backend`. **Rules:** [SHARED-RULES.md](SHARED-RULES.md) apply in full.

## Mission

Make N phones in a room play the same audio within **≤10 ms** of each other (≤30 ms is the floor), from a host's phone,
with per-phone stem assignment and a "tuning moment" that measures each phone's output latency. You own everything that
touches time: the room server, the shared protocol, and the headless browser engine the UI calls. The frontend agent is
building the screens against the mock server *right now* and will switch to your server at IC1 (≈H+6).

## Read first (in this order, ~25 minutes)

1. [SHARED-RULES.md](SHARED-RULES.md)
2. [docs/00-context.md](../docs/00-context.md) — why ≤10 ms, the physics, the error budget
3. [docs/01-architecture.md](../docs/01-architecture.md) — package graph, data flow
4. [docs/02-protocol.md](../docs/02-protocol.md) — the contract (mirrors `packages/protocol/src`)
5. [docs/03-sync-engine.md](../docs/03-sync-engine.md) — the algorithms you implement
6. [docs/04-calibration.md](../docs/04-calibration.md) — Tier 1 table, Tier 2 tuning moment, the measurement rig
7. [docs/05-effect-modes.md](../docs/05-effect-modes.md) — planner rules and the Vibe Director
8. [docs/07-tech-stack.md](../docs/07-tech-stack.md), [docs/08-roadmap.md](../docs/08-roadmap.md)
9. The code you inherit (below). Run `bun install && bun run fixtures && bun run typecheck && bun run test` before touching anything.

## You own / you never touch

Own: `apps/server/**`, `packages/protocol/**`, `packages/sync-client/**`, `fixtures/**`, `infra/**`, `evidence/backend/**`, this file's gate table.
Never: `apps/web/**`, `docs/**` (except appending to `docs/PROTOCOL-REQUESTS.md` and your rows in `docs/08-roadmap.md`).

## What already exists (IC0) and what is left

| area | exists | left for you |
|---|---|---|
| `packages/protocol` | zod schemas for every message, `RoomState`, `Assignment`; `plan()` (all 5 modes, stable, pin-aware); `evaluatePattern()`; `healthLevel()`; `ScenePlan`; constants; **mock server** with scenarios; 22 tests incl. a doc-diff test | keep it green; additive changes only, bump `PROTOCOL_VERSION`, mirror in `docs/02-protocol.md` and the mock |
| `packages/sync-client` | frozen public API (`src/index.ts`); `createStubClient` (`src/stub.ts`): real WS + JOIN + NTP probes + `ClockModel` (min-RTT) + host controls + reconnect, **no audio**; 2 tests | `createHiveClient`: the audio engine (B2–B4), calibration (B8). Reuse the stub's transport; keep the stub working (Playwright uses it) |
| `apps/server` | `Bun.serve` stub: `/health` + CORS | everything else (B0–B1, B5–B7) |
| `fixtures` | `gen-synthetic.ts` (4 WAV stems, 60 s, 120 BPM, drop at 30 s, `meta.json` with `energy[]`, `clickTimesSec[]`, `dropSec`) | `meta-from-wavs.ts` for real Demucs tracks (energy via RMS) — optional |
| `infra` | `fly.toml` (always-on, `bos`), `Dockerfile` | `.dockerignore`, deploy (B7) |

Non-goals for the hackathon: uploads/Demucs (B9 stretch), phone-to-phone ranging, playbackRate slewing (stretch), a database, auth beyond `hostKey`.

## Engineering notes you must not rediscover the hard way

- **Clock:** `performance.timeOrigin + performance.now()` everywhere; never `Date.now()` (phones step wall time). Port the NTP math
  from the stub's `ClockModel`; add coded probe **pairs** (`NTP_PROBE_PAIR_GAP_MS`, `NTP_PROBE_PAIR_TOLERANCE_MS`) and slewed application
  (≤2 ms per second unless the error is >`RESYNC_THRESHOLD_MS`). Sample `ctx.currentTime` (or `ctx.getOutputTimestamp()`) in the
  same tick as each probe so you map serverTime → ctx time directly, not via two mappings.
- **The formula** (`docs/02-protocol.md` §1): `ctxTime = ctx.currentTime + (serverTime − estServerNow)/1000 + delayMs/1000 − compensationMs/1000 − (no table && no calibration ? ctx.outputLatency||0 : 0)`.
  `compensationMs` arrives in the assignment; the client never adds the table itself.
- **Timeline:** only `room.transport`. On every `ROOM_STATE` while `playing`: `startCtx = ctxTimeFor(serverTimeAtTrackZero)`; if it is
  ≥ 50 ms in the future, `source.start(startCtx, 0)`; otherwise `source.start(now + 0.02, offset = now + 0.02 − startCtx)`. Never wait.
  Pause = stop sources. Seek = new PLAY. Late join, reconnect and `visibilitychange` all run the same function.
- **Audio graph:** one `AudioContext` ({latencyHint: "interactive"}); per stem `AudioBufferSourceNode → GainNode(stem dB)`; then
  `GainNode(pattern × mute) → destination`. Start all stems at the **same** ctx time with the same offset. Gain changes ramp with
  `setTargetAtTime(linear, at, 0.02)`; `applyAtServerTime` → `at = ctxTimeFor(applyAtServerTime)`. Pattern automation: every 100 ms
  schedule the next 200 ms of `evaluatePattern` values with `setValueCurveAtTime` (client-side, on the shared clock).
- **Drift:** every 1 s compare expected position (from transport) with actual (`ctx.currentTime − startCtx` + offset); if |err| >
  `RESYNC_THRESHOLD_MS`, hard resync: new sources at the right offset fade in over `RESYNC_CROSSFADE_MS` while the old fade out.
  Report the applied correction in `status.lastCorrectionMs` (it feeds `syncErrMs`).
- **iOS:** `audio.unlock()` runs inside the tap: `ctx.resume()`, play a 1-sample silent buffer, `navigator.audioSession.type = 'playback'`
  (guarded), `navigator.wakeLock.request('screen')` (re-request on `visibilitychange`). Handle `ctx.onstatechange` → `interrupted`/`suspended`:
  emit `audio: 'locked'` so the UI shows the tap button again; resume inside the next gesture. Use **WAV** stems (`decodeAudioData`
  on MP3 differs by browser by up to ~25 ms).
- **Memory:** ≤4 mono stems ≤60 s decoded ≈ 42 MB at 44.1 kHz. Fine. Do not add a stereo mix (stretch only).
- **Server:** in-memory rooms; `ws.subscribe(code)` + `server.publish(code, …)`; `ROOM_STATE` coalesced to `ROOM_STATE_MAX_HZ` with a
  dirty flag (joiners get one immediately); `HEALTH` to `hostClientIds` at `HEALTH_HZ`; `PING` every `PING_INTERVAL_MS`; disconnected
  records kept `DISCONNECT_RETENTION_MS`; a JOIN with a known `clientId` restores the record (`joinIndex`, position, assignment);
  `ROOM_FIXED_CODE` env makes `POST /rooms` idempotent so the demo QR survives a restart. The mock server is a working reference for
  every handler — copy its structure, replace the fakes.
- **Calibration (Tier 2, host phone listens):** click = 2 ms 2 kHz burst + 20 ms linear chirp 2→6 kHz, Hann-windowed
  (`DEFAULT_CLICK_SPEC`), synthesized in `calibration.renderClick`. Reference records via `getUserMedia({audio:{echoCancellation:false,
  autoGainControl:false, noiseSuppression:false}})` → `MediaStreamAudioSourceNode → AudioWorkletNode` capturing Float32 chunks stamped
  with `ctx.currentTime` (ScriptProcessor fallback). For each player, cross-correlate ±150 ms around the expected arrival
  (`startServerTime + i·intervalMs`, mapped through the reference's own clock), pick the peak, `residual = peak − expected` (ms),
  `confidence = peak / (mean|xcorr| + 3σ)` clamped to 1. Subtract the **median** residual across players (only relative offsets matter;
  the reference's input latency cancels). Report `CALIBRATION_REPORT`; server does `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs ?? 0) + residual`.
  Release the mic (`track.stop()`) afterwards. Propagation error ≈ 2.9 ms/m: the UI tells people to hold phones near the host.
- **Vibe Director:** `@anthropic-ai/sdk`, `client.messages.parse({ model: process.env.VIBE_MODEL ?? "claude-sonnet-5", max_tokens: 4096,
  system, messages, output_config: { format: zodOutputFormat(ScenePlanCoreSchema) } })`; `parsed_output === null` or any throw or a 5 s
  timeout → `vibe/rules.ts`. Rules: keyword table (calm/chill → UNISON with `stemGainsDb` trims or ORCHESTRA vocals; build → ORCHESTRA;
  drop/explode/party → WAVE then STROBE for 16 s; stereo/wide → STEREO) placed at `meta.dropSec` when present, else the first second
  whose energy exceeds 1.15× the median of the preceding 10 s. Scene timer: `LEAD_MS` before each boundary set `mode`, re-plan with
  `applyAtServerTime = boundary`, broadcast. `SET_MODE` clears the plan.
- **Fly:** `fly launch --copy-config --dockerfile infra/Dockerfile` from the root; keep `auto_stop_machines = false`; `.dockerignore` at the repo root already excludes
  `node_modules`, `.git`, `evidence`, `apps/web/.next` and the generated WAVs (the image regenerates them). Cellular RTT asymmetry breaks the 10 ms target: B7 is a connectivity check only; the demo runs on one Wi-Fi/hotspot.

## Ordered tasks and gates

Update the **status** column as you go (⬜ not started · 🟨 in progress · ✅ passed · 🟡 needs human · ❌ blocked → request written).

| gate | deliverable (files) | check | evidence | status |
|---|---|---|---|---|
| **B0** | `apps/server`: `GET /health`, `POST /rooms` (fixed code), `GET /rooms/:code`, `GET /tracks?q=` from `fixtures/tracks/*/meta.json` with `urls`, `GET /audio/:id/:stem.wav` (static, cache headers), CORS on all | `curl` each route; `bun run typecheck && bun run test` green | `evidence/backend/B0-routes.txt` | ✅ `apps/server/src/{config,clock,library,rooms,room,rest,server,index}.ts`; 8 route tests in `src/__tests__/rest.test.ts` + curl transcript. Extras beyond the brief: single-`Range` support on `/audio` (iOS probes with `bytes=0-1`), `GET /rooms/:code` 404s on an unknown code, stem URLs built from the request origin so the same binary works on localhost and Fly |
| **B1** | `apps/server/src/room.ts` + `ws.ts`: JOIN/WELCOME, hostKey, NTP responder (t1 on receive, t2 on send), coalesced `ROOM_STATE`, `HEALTH` to hosts, `PING/PONG`, reconnect-by-clientId, `SET_PLAYS`, `KICK`, `SET_TRACK`, `TRANSPORT`, `SET_MODE`, `ASSIGN`, `SET_POSITION`, `NUDGE` (host or self) with `plan()` on every change | `apps/server/src/__tests__/room.test.ts` modelled on `packages/protocol/src/__tests__/mock-server.test.ts`: 3 fake clients join; `t1 ≤ t2`; snapshot lists them; disconnect + rejoin keeps `joinIndex`; **20 simultaneous joins** complete < 2 s; a player sending `TRANSPORT` gets `NOT_HOST` | `evidence/backend/B1-room-test.txt` (test output) | ✅ `apps/server/src/{room,rooms,ws}.ts`; 12 tests. 20 simultaneous joins → WELCOME + one full snapshot in **170–195 ms** (budget 2 s). Coalescing is leading-edge (first change out in <100 ms, then ≤`ROOM_STATE_MAX_HZ`). Error-code set announced in `docs/PROTOCOL-REQUESTS.md` R-1 |
| **B2** | `packages/sync-client/src/clock.ts`: `ClockModel` + coded probe pairs + slewing + serverTime↔ctx mapping; `createHiveClient` connects and syncs (no audio yet) | unit test with a fake transport: injected +137 ms offset, ±30 ms jitter, 20 % spikes of +80 ms, pair-rejection on → offset error **< 2 ms over 30 probes**; slew never steps > 2 ms/s below threshold | `evidence/backend/B2-clock-test.txt` | ⬜ |
| **B3** | `packages/sync-client/src/audio.ts` + `scheduler.ts`: unlock, stem loading with progress, `AUDIO_READY`, transport-derived start/pause/seek/late-join, visibility/`interrupted` handling; **the measurement rig** `packages/sync-client/rig/` (a page: reference laptop/phone records while two devices play the synthetic click track; prints per-device arrival offsets using the same cross-correlation code as B8) | unit test: ctx mapping with a mocked clock (playing / paused / late join / seek); rig run: two devices play `synthetic-60s` drums, table compensation on → clicks within **10 ms**; kill the server mid-song → both devices rejoin and resume within 5 s at the right position | `evidence/backend/B3-rig.md` (numbers + screenshot), `B3-restart.md` | ⬜ |
| **B4** | drift handling (hard resync + crossfade), Tier-1 table in `constants.ts` measured per browser family you have on hand, nudge → `compensationMs` end to end | rig at t=0 and t=5 min both < 10 ms; nudge +40 ms on one device shifts its click by **40 ± 3 ms** in the rig; unit test: simulated +50 ppm audio clock stays within 5 ms over 5 min via resyncs | `evidence/backend/B4-drift.md`, `B4-nudge.md` | ⬜ |
| **B5** | server uses `withAssignments` on every change; `applyAtServerTime` honoured in the engine (gain ramps at the exact ctx time); pattern automation (`evaluatePattern`) in the engine; `SET_MODE` for all 5 modes | planner tests already exist; add engine test: switching UNISON→ORCHESTRA changes gains only (no reload, `AUDIO_READY` not re-sent); manual: two phones, ORCHESTRA, each hears a different stem | `evidence/backend/B5-modes.md` | ⬜ |
| **B6** | `apps/server/src/vibe/{director,rules}.ts`, `POST /rooms/:code/vibe`, scene timer, `VIBE_MODEL` env | `bun test`: with `ANTHROPIC_API_KEY` unset the rules path returns a schema-valid plan whose first scene is calm and which switches to WAVE/STROBE at `dropSec`; with a key, 10 runs of "calm, then explode at the drop" on `synthetic-60s` → all schema-valid, ≥2 scenes, a low-energy mode before 30 s and WAVE or STROBE after | `evidence/backend/B6-vibe.md` (10 plans) | ⬜ |
| **B7** | Fly deploy (`infra/`), env set (`CORS_ORIGIN` = Vercel origin, `ROOM_FIXED_CODE`, `VIBE_MODEL`) | `curl https://<app>.fly.dev/health` → 200; a phone on cellular joins over WSS and reaches `audio: ready` | `evidence/backend/B7-deploy.md` | ⬜ |
| **B8** | Tier 2 in-app tuning: server `CALIBRATION_START/PLAN/CLICK/REPORT` + residual accumulation + `calibration` state; engine `calibration.runAsReference` (mic, worklet capture, xcorr, median-anchoring, mic release) and `calibrationClick` event | unit test: synthetic recording = click template delayed by 23.4 ms + noise → residual within **1 ms**; real: host phone listens, one player nudged +40 ms → recovered **40 ± 5 ms**; a phone that is not playing (`plays:false`) is never in `order` | `evidence/backend/B8-calibration.md` | ⬜ |
| **B9** (stretch) | `POST /tracks` → Replicate Demucs → stems → `meta-from-wavs.ts`; crowd-sourced latency table (persist nudges by browser family); playbackRate slewing | only after B8 | – | ⬜ |

Order is the order above. IC1 needs B0–B2 + a runnable `apps/server`; IC2 needs B3–B4; IC3 needs B5–B6; rehearsal needs B7–B8.

## Definition of done for each commit

`bun run typecheck && bun run test` green at the root; the mock server still passes its test; `docs/02-protocol.md` tables still match
(the schema test enforces it); gate table updated; evidence file present.

## When to write to `docs/PROTOCOL-REQUESTS.md`

You will mostly **answer** entries there (the frontend asks). When you add something to the contract on your own initiative, announce
it there too so the frontend agent sees it. When a gate needs a second phone or a quiet room you do not have, mark 🟡 with the manual
checklist in the evidence file and continue.
