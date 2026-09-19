# Engine agent brief — sync engine + protocol (formerly "backend")

**Model:** Claude Opus 5. **Branch:** `agent/backend`. **Rules:** [SHARED-RULES.md](SHARED-RULES.md) apply in full.

> **Revised scope (demo-first split):** the room server, vibe director and infra now belong to the **server agent**
> ([SERVER-AGENT.md](SERVER-AGENT.md), Sonnet 5, branch `agent/server`). You own the browser engine and the contract. Work the
> gates in the **demo-first order** below: everything the first real phone test needs comes before drift correction and the
> tuning moment.

## Mission

Make N phones in a room play the same audio within **≤10 ms** of each other (≤30 ms is the floor), from a host's phone,
with per-phone stem assignment and, in the second round, a "tuning moment" that measures each phone's output latency. You own
the browser engine (`packages/sync-client`) and the contract (`packages/protocol`). The frontend agent is building the screens
against the mock and the stub *right now* and switches to your engine with `NEXT_PUBLIC_HIVE_ENGINE=real`; the server agent is
porting the mock into `apps/server` in parallel.

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

Own: `packages/protocol/**`, `packages/sync-client/**`, `evidence/backend/**`, this file's gate table, your rows in `docs/08-roadmap.md`.
Never: `apps/server/**`, `infra/**`, `fixtures/**` (server agent), `apps/web/**` (frontend agent), other docs. You are the only
writer of `packages/protocol`: answer the other agents' requests in `docs/PROTOCOL-REQUESTS.md` promptly (additive, bump `PROTOCOL_VERSION`, update the mock in the same commit).

## What already exists (IC0) and what is left

| area | exists | left for you |
|---|---|---|
| `packages/protocol` | zod schemas for every message, `RoomState`, `Assignment`; `plan()` (all 5 modes, stable, pin-aware); `evaluatePattern()`; `healthLevel()`; `ScenePlan`; constants; **mock server** with scenarios; 22 tests incl. a doc-diff test | keep it green; additive changes only, bump `PROTOCOL_VERSION`, mirror in `docs/02-protocol.md` and the mock |
| `packages/sync-client` | frozen public API (`src/index.ts`); `createStubClient` (`src/stub.ts`): real WS + JOIN + NTP probes + `ClockModel` (min-RTT) + host controls + reconnect, **no audio**; 2 tests | `createHiveClient`: the audio engine (B2–B4), calibration (B8). Reuse the stub's transport; keep the stub working (Playwright uses it) |
| `apps/server` | `Bun.serve` stub: `/health` + CORS | everything else (B0–B1, B5–B7) |
| `fixtures` | `gen-synthetic.ts` (4 WAV stems, 60 s, 120 BPM, drop at 30 s, `meta.json` with `energy[]`, `clickTimesSec[]`, `dropSec`) | `meta-from-wavs.ts` for real Demucs tracks (energy via RMS) — optional |
| `infra` | `fly.toml` (always-on, `ewr` (Newark; Fly retired `bos`)), `Dockerfile` | `.dockerignore`, deploy (B7) |

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
- **Fly:** (server agent) `fly.toml` is at the repo root; keep `auto_stop_machines = false`; `.dockerignore` at the repo root already excludes
  `node_modules`, `.git`, `evidence`, `apps/web/.next` and the generated WAVs (the image regenerates them). Cellular RTT asymmetry breaks the 10 ms target: B7 is a connectivity check only; the demo runs on one Wi-Fi/hotspot.

## Ordered tasks and gates (demo-first order)

Update the **status** column as you go (⬜ not started · 🟨 in progress · ✅ passed · 🟡 needs human · ❌ blocked → request written).
Gate ids keep their original numbers so the roadmap stays readable; the **order below is the order you work**. Server-side halves
of B5/B8 and all of B0/B1/B6/B7/B9 are the server agent's.

| # | gate | deliverable (files) | check | evidence | status |
|---|---|---|---|---|---|
| 1 | **B2** | `packages/sync-client/src/clock.ts`: `ClockModel` + coded probe pairs + slewing + serverTime↔ctx mapping sampled per probe; `createHiveClient` connects and syncs (reuse the stub's transport) | unit test with a fake transport: +137 ms offset, ±30 ms jitter, 20 % spikes of +80 ms, pair-rejection on → offset error **< 2 ms over 30 probes**; slew ≤ 2 ms/s below threshold | `evidence/backend/B2-clock-test.txt` | ✅ `src/{clock,transport,client}.ts`; 17 tests. +137 ms / ±30 ms / 20 % spikes → **0.715 ms** final error, **1.942 ms** worst once ≥6 samples are in the window; slew cap 2 ms/s honoured, >10 ms applied in one step. `createHiveClient` joins/syncs/drives the room against the mock (`audio.unlock()` throws until B3-lite). transport.ts is now shared with the stub. **Negative result recorded:** coded pairs add nothing measurable on top of min-RTT — kept anyway, see the evidence file |
| 2 | **B3-lite** | `audio.ts` + `scheduler.ts`: unlock (resume, silent buffer, `audioSession`, wake lock), stem loading with progress → `AUDIO_READY`, transport-derived start/pause/seek/late-join, `visibilitychange`/`interrupted` resync, `calibrationClick` event playing the synthesized click | unit test: ctx mapping with a mocked clock (start-from-zero / paused / late join / seek); a headless smoke test that two `createHiveClient`s against the mock reach `audio: ready` and compute the same `trackTimeSec` within 5 ms | `evidence/backend/B3-scheduler-test.txt` | ✅ `src/{audio,scheduler}.ts`, `src/calibration/click.ts`, test helper `src/__tests__/fake-audio.ts`; 29 tests. Both docs/03 worked examples asserted literally; two engines against the mock reach `audio: ready` and schedule the same instant to **0.005 ms** (arithmetic, not phones — see the evidence file). Found and fixed: pattern automation never ran for a future start (WAVE/STROBE would have silently done nothing on a freshly started track). 🟡 the phone-only half of `unlock()` (silent switch, lock screen, wake lock, real `outputLatency`) is a 5-item checklist in the evidence file for INT |
| 3 | **B5e** | gain ramps from `assignment.gainsDb` (`setTargetAtTime`, 20 ms), `applyAtServerTime` honoured at the exact ctx time, pattern automation via `evaluatePattern` (100 ms look-ahead, `setValueCurveAtTime`), local mute | test: UNISON→ORCHESTRA changes gains only (no reload, no second `AUDIO_READY`); WAVE assignment produces a delayed start of `delayMs` | `evidence/backend/B5-engine.md` | ⬜ |
| 4 | **INT** | integration: PR to `main` ("engine v1"); with the frontend on the deployed stack, `NEXT_PUBLIC_HIVE_ENGINE=real` — **this is the first real phone test** | the human runs 3 phones in unison + orchestra + wave; you fix what they report | `evidence/backend/INT-first-test.md` | ⬜ |
| 5 | **B4** | hard-resync drift handling with 20 ms crossfade; Tier-1 table measured per browser family you can reach; nudge end to end | simulated +50 ppm audio clock stays within 5 ms over 5 min; nudge +40 ms shifts the scheduled start by 40 ms exactly (unit) | `evidence/backend/B4-drift.md` | ⬜ |
| 6 | **B8e** | `calibration.runAsReference` (mic with EC/AGC/NS off, worklet capture, cross-correlation, ±150 ms window, median anchoring, `CALIBRATION_REPORT`, mic release) + `renderClick`; **the measurement rig** `packages/sync-client/rig/` reusing the same DSP | unit: synthetic recording = template delayed 23.4 ms + noise → residual within **1 ms**; two templates 300 ms apart resolved independently; real run 🟡 for the human (+40 ms nudge recovered ±5 ms) | `evidence/backend/B8-calibration.md` | ⬜ |
| 7 | **B9e** (stretch) | `playbackRate` slewing instead of hard resync | after B8e | – | ⬜ |

Open a PR to `main` after step 3 (INT) and again after B4 and B8e. The frontend's F8 (first full test) and the server's B1 gate meet you at INT.

## Definition of done for each commit

`bun run typecheck && bun run test` green at the root; the mock server and the stub still pass their tests (the frontend's Playwright
suite depends on both); `docs/02-protocol.md` tables still match (the schema test enforces it); gate table updated; evidence file present.

## When to write to `docs/PROTOCOL-REQUESTS.md`

You will mostly **answer** entries there (the frontend and the server agent ask; you are the only writer of `packages/protocol`). When you add something to the contract on your own initiative, announce
it there too so the frontend agent sees it. When a gate needs a second phone or a quiet room you do not have, mark 🟡 with the manual
checklist in the evidence file and continue.
