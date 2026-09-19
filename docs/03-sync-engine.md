# HiveMusic — Sync Engine (`@hive/sync-client`)

Owner: backend agent

`@hive/sync-client` is the headless browser engine: WebSocket + reconnect, clock model, AudioContext, stem preload, scheduling, drift correction, pattern gain automation, calibration click emit/listen, wake lock, device detection. `apps/web` never creates its own AudioContext or WebSocket; it calls this API through the `useHiveClient` hook it owns. The public surface is frozen at IC0 in `packages/sync-client/src/index.ts`; `createHiveClient` throws "not implemented" until B2–B4 fill it in, and `createStubClient` (`src/stub.ts`) speaks the full protocol with no audio so the frontend can build against the mock. Wire contract: [02-protocol.md](02-protocol.md). Calibration internals: [04-calibration.md](04-calibration.md).

## Public API (frozen at IC0)

The plan's shorthand — `createHiveClient({wsUrl, apiUrl, roomCode, kind, plays, hostKey?, name?})` → `connect()/disconnect()`, `on(...)`, `room`, `me`, `connection`, `audio`, `loadProgress`, `audio.unlock()`, `clock.serverNow()`, `clock.trackTimeSec()`, `status {…}`, `host.{…}`, `calibration.runAsReference({onProgress})`, `detectDevice()` — is realised by these types (`index.ts` wins over any prose):

```ts
createHiveClient(opts: HiveClientOptions): HiveClient
  HiveClientOptions { wsUrl, apiUrl, roomCode, kind: 'host'|'player', plays, hostKey?, name?, clientId? }

HiveClient
  clientId                       // UUID persisted in localStorage as hive:clientId:<roomCode>
  room: RoomState | null         // latest ROOM_STATE
  me: ClientRecord | null        // room.clients[clientId]
  assignment: Assignment | null  // me.assignment
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed'
  status: SyncStatus             // { clockOffsetMs, rttMs, syncErrMs, outputLatencyMs, compensationMs, lastCorrectionMs, playing }
  clock: { serverNow(), trackTimeSec(), ctxTimeFor(serverTime) }
  audio: { unlock(): Promise<void>, state: AudioState, loadProgress, setMuted(m), muted }
  host:  { setTrack, play(trackTimeSec?), pause(), seek(t), setMode(mode, params?), assign(id, role|null),
           setPosition(id, x, y), nudge(id, ms), setPlays(plays), kick(id), startCalibration(): Promise<void>, vibe(prompt): Promise<ScenePlan> }
  calibration: { runAsReference({onProgress?}): Promise<CalibrationResult>, renderClick(spec, sampleRate): Float32Array }
  nudgeSelf(ms)                  // players nudge themselves; hosts nudge anyone via host.nudge
  connect(): Promise<void>       // resolves on WELCOME
  disconnect()
  on(event, handler): () => void // returns the unsubscribe
  off(event, handler)

HiveEvents
  state(room)                    // full snapshot, ≤2 Hz; render from it, never diff
  health(clients, serverTime)    // hosts only, 1 Hz
  status(status)                 // after every probe
  connection(state)
  audio(state, loadProgress)
  assignment(assignment | null)  // own assignment changed (derived from state)
  calibrationClick(clickAtServerTime)   // player screens flash; the engine plays the click
  error(code, message)

detectDevice(userAgent?) → DeviceInfo { userAgent, platform, browserFamily, model? }
  browserFamily ∈ 'ios-safari' | 'android-chrome' | 'desktop-chrome' | 'desktop-safari' | 'other'
  (every iOS browser is WebKit → 'ios-safari')
```

Semantics the implementation must keep:

- `audio.state` is the string the plan calls `audio`; `audio.loadProgress` is the plan's `loadProgress`.
- `host.setPosition` is throttled to `SET_POSITION_MAX_HZ = 10` **inside the engine** (the UI may call it every frame; the last value on release still gets through because the stub sends when the interval has elapsed — the real engine also flushes the final value, assumption).
- `host.startCalibration()` sends `CALIBRATION_START {referenceClientId: clientId}` and resolves when `room.calibration.state` becomes `done` or `failed`.
- `host.vibe(prompt)` POSTs `/rooms/:code/vibe` and resolves with `scenePlan` (LLM or rules).
- `clock.ctxTimeFor(S)` = the AudioContext time at which server time `S` reaches this device's speaker, i.e. the plain clock mapping below without compensation or delay (the engine applies those when it schedules sources). The UI uses it to time flashes; the stub returns seconds-from-now.
- `nudgeSelf(ms)` sends `NUDGE {clientId: me, nudgeMs}`; the server accepts `NUDGE` from a player only for its own id.
- Reconnect: `connection` → `reconnecting`, backoff `min(5000, 300·2^min(attempt,4))` ms (300, 600, 1200, 2400, 4800), re-`JOIN` with the same `clientId`, `WELCOME` resets the counter. `ERROR KICKED` closes for good (`room = null`).

## Sign conventions

| Quantity | Definition | Positive means |
|---|---|---|
| `localNow` | `performance.timeOrigin + performance.now()` (epoch ms, monotonic within a page) | — |
| `clockOffsetMs` | `serverTime − localNow` | server clock reads ahead of this phone |
| `estServerNow` | `localNow + clockOffsetMs` | — |
| `compensationMs` | `nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0)`, computed server-side, delivered in the assignment | device is late → start it earlier |
| `nudgeMs` | slider, ±`NUDGE_RANGE_MS` = ±100; "sounds late" → positive | advance this phone |
| `delayMs` | from the assignment (WAVE), 0..1000 | play this phone later |
| `residualMs` | calibration ([04](04-calibration.md)) | click arrived late → add to compensation |

All wire times are ms floats on the server clock. AudioContext times are seconds. Never use `Date.now()` for timing.

## Clock model (NTP client)

Per probe: `t0` client send, `t1` server receive, `t2` server send, `t3` client receive (Beatsync `ntp.ts` math, re-typed in `ClockModel`):

```
offset = ((t1 − t0) + (t2 − t3)) / 2      // serverTime − clientTime
rtt    = (t3 − t0) − (t2 − t1)
```

| Aspect | Rule (constants in `constants.ts`) |
|---|---|
| Burst | `NTP_BURST_COUNT = 20` coded pairs over `NTP_BURST_WINDOW_MS = 4000` — one pair every 200 ms, as the stub does — right after `WELCOME`; the first estimate is adopted directly (there is nothing to slew from). |
| Steady state | one coded pair every `NTP_STEADY_INTERVAL_MS = 1000`. |
| Coded probe pairs | A pair shares `probeGroupId`; `probeGroupIndex` 0 then 1, departing `NTP_PROBE_PAIR_GAP_MS = 10` ms apart. The server echoes both ids with `t1`/`t2`. If `\|(t1[1] − t1[0]) − (t0[1] − t0[0])\| > NTP_PROBE_PAIR_TOLERANCE_MS = 2`, the pair was queued on the path and both samples are rejected. |
| Window | sliding window of the last `NTP_WINDOW = 30` accepted samples. |
| Selection | the sample with minimum `rtt` in the window: its `offset` is the estimate, its `rtt` is `status.rttMs`. |
| Application | **slewed, never stepped** after the first estimate: `clockOffsetMs` moves toward the estimate at ≤2 ms/s (assumption on rate). A +50 ppm local-clock drift is 0.05 ms/s, far inside the slew rate, so `estServerNow` stays within the ±2–5 ms budget indefinitely (B4). A real jump (route change) shows up as audio error and is handled by the hard resync below, not by the clock. |
| Reconnect | keep the applied offset; restart the burst; keep the old window until 10 new samples are accepted (assumption). |

B2 acceptance: fake transport with +137 ms offset, ±30 ms jitter, 20 % spikes → estimate within 2 ms after 30 probes. `ClockModel` takes `addProbe(t0, t1, t2, t3)` so the test needs no network.

## serverTime ↔ AudioContext mapping

In the same synchronous tick as every probe send, sample `(localNow, ctx.currentTime)` and keep the last 10 pairs:

```
localToCtx = median(ctx.currentTime − localNow / 1000)                 // seconds
ctxAt(S)   = localToCtx + (S − clockOffsetMs) / 1000                    // any server time S → ctx seconds
           ≈ ctx.currentTime + (S − estServerNow) / 1000                // identical when read in one tick
clock.ctxTimeFor(S) = ctxAt(S)
```

The one-tick form is the plan's scheduling formula; the sampled form is used by the drift check and by calibration timestamps. Unit test (B3): a synthetic `(local, ctx)` series with +50 ppm drift and 5 ms jitter maps a server time to within 2 ms.

## Transport-derived scheduling

The server sets on PLAY/SEEK (`from = trackTimeSec ?? (paused ? trackTimeAtPause : 0)`):

```
serverTimeAtTrackZero = now + LEAD_MS − from · 1000      // LEAD_MS = 600
```

Every speaker must emit track position `p` (seconds) at server time `S(p) = serverTimeAtTrackZero + p·1000 + delayMs`. Sound leaves the speaker `compensationMs` after the ctx time we schedule, so (the plan's formula from [02](02-protocol.md) §1, with `serverTime = serverTimeAtTrackZero + p·1000`):

```
ctxTime = ctx.currentTime
        + (serverTime − estServerNow) / 1000
        + delayMs / 1000
        − compensationMs / 1000
        − (tableLatencyMs == null && calibratedOffsetMs == null ? (ctx.outputLatency || 0) : 0)
```

**Start from zero (worked example).** `estServerNow = 1 000 000.0`, `ctx.currentTime = 12.000`. PLAY was issued at `999 850` with `from = 0` → `serverTimeAtTrackZero = 999 850 + 600 = 1 000 450`. UNISON (`delayMs = 0`), iOS Safari with no calibration and no nudge → `compensationMs = 0 + 60 = 60` (starter table).

```
ctxTime = 12.000 + (1 000 450 − 1 000 000) / 1000 + 0 − 0.060 = 12.390
for each stem: source.start(12.390, 0)
```

**Late join / resume (worked example).** Same room, `estServerNow = 1 030 000` (the start is 29.55 s in the past), `ctx.currentTime = 42.000`. Pick `ctxStart = ctx.currentTime + 0.050` (50 ms safety margin, assumption) and solve for the offset into the track:

```
p = (estServerNow + 50 − serverTimeAtTrackZero − delayMs + compensationMs) / 1000
  = (1 030 000 + 50 − 1 000 450 − 0 + 60) / 1000 = 29.660
for each stem: source.start(42.050, 29.660)
check: position 29.660 leaves the speaker at ctx 42.050 + 0.060 = 42.110
       → server time 1 030 110 = S(29.660) = 1 000 450 + 29 660 ✓
```

`clock.trackTimeSec()` = `trackTimeSec(room.transport, clock.serverNow())` from `@hive/protocol`: `playing → max(0, (estServerNow − serverTimeAtTrackZero)/1000)`, `paused → trackTimeAtPause`, `stopped → 0`.

Rules:

- All stems start in one synchronous sequence with the identical `when`; each stem has its own `GainNode` (dB → linear `10^(dB/20)`; `−60 dB` is silence), summed into a pattern `GainNode`, then a master `GainNode` → `ctx.destination`. `audio.setMuted(true)` = master gain 0 (local only).
- A `ROOM_STATE` whose `(track.id, transport)` differs from the last applied one is a transport change: `paused`/`stopped` → stop sources with a 10 ms fade (assumption; [02](02-protocol.md) allows a 100 ms ragged pause edge); `playing` → schedule as above, immediately if the start is already past.
- A change in `compensationMs` or `delayMs` while playing changes the target position; the drift check picks it up and resyncs if the change exceeds `RESYNC_THRESHOLD_MS`, otherwise the residual is carried until the next resync (v1 accepts this; slewing is stretch).
- New `gainsDb` ramp with `linearRampToValueAtTime` over 50 ms (assumption), starting at `ctxAt(applyAtServerTime)` when set and in the future, else now. A new `pattern` takes effect at the same instant.

## Drift check and hard resync

Every 1 s while playing — and immediately on a transport change, `visibilitychange` → visible, or `statechange` → running — once `ctx.currentTime ≥ startCtxTime`:

```
emittedNow = startOffsetSec + (ctx.currentTime − startCtxTime) − compensationMs / 1000
             [− outputLatency in the no-table/no-calibration case]     // position leaving the speaker now
targetNow  = (estServerNow − serverTimeAtTrackZero − delayMs) / 1000   // position that should be leaving it
errorMs    = (emittedNow − targetNow) · 1000                            // positive = this phone is ahead
```

If `|errorMs| > RESYNC_THRESHOLD_MS = 10`: create new sources at the corrected position starting at `ctx.currentTime + 0.05`, crossfade `RESYNC_CROSSFADE_MS = 20` (old branch gain 1→0, new branch 0→1, linear), stop the old sources after the fade, and set `status.lastCorrectionMs = errorMs`. If `|errorMs| ≤ 10`: no audio change and `lastCorrectionMs` keeps its previous value (the `SyncStatus` doc says "last hard resync applied, 0 when none").

```
syncErrMs := rttMs / 2 + |lastCorrectionMs|          // computeSyncErrMs() in @hive/protocol
```

An upper bound on how far this phone may be from the server timeline. `healthLevel(h, now)` colours it: `good ≤ 5`, `warn ≤ 20`, `bad` above **or when `lastSeenServerTime` is older than 5 s**, `unknown` when `syncErrMs` is null. The phone reports it in `CLIENT_STATUS` every 2 s; hosts see it in `HEALTH` at 1 Hz. The stub reports `rttMs / 2`.

B4 acceptance: rig at t=0 and t=5 min both <10 ms device-to-device; a +40 ms nudge shifts the measured click by 40±3 ms; simulated +50 ppm clock drift keeps the clock estimate within 5 ms.

## Audio state machine, unlock sequence, iOS

```
locked ──audio.unlock() in a gesture──▶ unlocked ──room.track known──▶ loading ──all stems decoded──▶ ready
   ▲                                                                                              │
   └────── ctx.state became 'interrupted'/'suspended' and resume() was refused (no gesture) ──────┘
```

`audio.unlock()` runs inside the tap handler, synchronously before any `await` (its doc comment is the contract):

1. Create the `AudioContext` once (`{ latencyHint: 'interactive' }`, default sample rate).
2. `if ('audioSession' in navigator) navigator.audioSession.type = 'playback'` — Safari 17+, feature-guarded; without it the iOS silent switch mutes Web Audio.
3. `await ctx.resume()`.
4. Start a one-sample silent buffer (`source.start(0)`) to satisfy WebKit's gesture requirement.
5. Read `ctx.outputLatency` (may be `undefined` → `status.outputLatencyMs = null`).
6. `navigator.wakeLock.request('screen')` (HTTPS; failures are logged, never thrown); re-request on `visibilitychange` → visible (assumption).

Stems: when `room.track` is known and the state is `unlocked` (or the track id changes after `SET_TRACK`), fetch every `${apiUrl}/audio/${track.id}/${stem}.wav` in parallel, `decodeAudioData` each, keep the `AudioBuffer`s (≤4 × 60 s mono 44.1 kHz ≈ 42 MB as Float32). `audio.loadProgress` = bytes received / total, with decode counted as the final 5 % (assumption). When **every stem is decoded** send `AUDIO_READY {trackId}` and set `ready`. `AUDIO_READY` never means "first stem playable". The server stores it as `clients[id].audioReadyTrackId`; the Lobby's Start button waits for it ([06](06-hive-map-ui.md)) but the server never blocks `PLAY` — a phone that becomes ready after `PLAY` late-joins through the normal path.

Interruptions: iOS moves the context to `'interrupted'` on lock screen or call; Android to `'suspended'` on backgrounding. On `statechange` → running or `visibilitychange` → visible, run the drift check immediately (it will resync). If `ctx.resume()` rejects outside a gesture, set `audio.state` to `locked` with buffers retained; the UI shows "Tap to resume" and the next `audio.unlock()` returns straight to `ready`. Never call `getUserMedia` on a playing phone: it switches iOS into play-and-record and changes volume and latency — calibration listening runs only on the non-playing host phone.

Heartbeat: answer every `PING {serverTime}` with `PONG` (the server stamps `lastSeenServerTime`). Server-restart recovery within 5 s is a B3 check.

## Latency table (Tier 1)

`STARTER_LATENCY_TABLE_MS` in `constants.ts`, applied server-side as `tableLatencyMs` on `JOIN` from `device.browserFamily`, used when `calibratedOffsetMs` is null. Only the **differences** between rows matter — a common offset shifts every phone equally. Starter guesses; measure with the rig ([04](04-calibration.md)) and replace before B4 is signed off:

| browserFamily | tableLatencyMs | Note |
|---|---|---|
| `ios-safari` | 60 | `outputLatency` unreliable (WebKit FIXME); starter guess; calibrate |
| `android-chrome` | 45 | 20–100+ ms spread across devices; starter guess; calibrate |
| `desktop-chrome` | 25 | starter guess; calibrate |
| `desktop-safari` | 30 | starter guess; calibrate |
| `other` | null | client subtracts `ctx.outputLatency \|\| 0` instead |

Nudge semantics: `NUDGE {clientId, nudgeMs}` with `nudgeMs ∈ [−100, 100]` (`NUDGE_RANGE_MS`), whole ms. The server recomputes `compensationMs` and broadcasts; the phone applies it through the drift check. The player slider ("sounds early / sounds late", debounced 150 ms on release) calls `nudgeSelf`; the host's player sheet calls `host.nudge(id, ms)`. Late → positive → advance.

## Pattern evaluation on the shared clock

For an assignment with a non-null `pattern`, the engine evaluates `evaluatePattern(pattern, trackTimeMs)` from `@hive/protocol` and schedules gain automation on the pattern `GainNode` one period ahead, keyed off `clock.trackTimeSec()`: `strobe` is a square gate with `rampMs` (10 ms) linear edges and `duty` (0.5); `wave` is a raised-cosine swell `0.5 − 0.5·cos(2π·t/periodMs)` (0 at the phase origin, 1 half a period later). Both are gain multipliers in `[0, 1]` and both are applied to the audio; the UI evaluates the same function per frame for the screen. No per-tick messages. Details and the planner's phases are in [05-effect-modes.md](05-effect-modes.md).

## Error budget (mechanism view)

| Term | Mechanism | Budget |
|---|---|---|
| Clock | min-RTT over 30 samples, coded pairs, slewed application | ±2–5 ms |
| Output latency | table → nudge → Tier 2 | ±10–20 → ±5 → ±2–3 ms |
| Scheduling | `source.start(when)` at a computed ctx time; 128-sample render quantum | ≤3 ms |
| Drift | hard resync at >10 ms, 20 ms crossfade | ≤10 ms transient, ~0 after |
| Total after Tier 2 | RSS | ~4–7 ms vs the ≤10 ms target; ≤30 ms floor |

Full table with per-mode needs: [00-context.md](00-context.md#error-budget).

## Testing hooks

- `ClockModel.addProbe(t0, t1, t2, t3)` is pure; B2 runs under `bun test` with a fake transport.
- The scheduler takes an injectable `ctx`-like object (`currentTime`, `createBufferSource`, `createGain`) for the B3 mapping test (assumption on the seam).
- `calibration.renderClick(spec, sampleRate)` is exposed so the rig and the xcorr tests use the exact waveform the phones play.
- `/diag` in `apps/web` shows `ctx.state`, `sampleRate`, `outputLatencyMs`, `clockOffsetMs`, `rttMs`, `syncErrMs`, `audio.state`, wake-lock state and `navigator.audioSession?.type` — the F1/F3 checklist reads from `status` and the `audio` event.
- `createStubClient` must keep working: Playwright depends on it.

## Stretch (after B8)

- `playbackRate` slewing (±0.5 %) to remove drift without crossfades.
- Crowd-sourced latency table: calibration residuals per `device.model` aggregated server-side.
- BeepBeep two-way ranging for auto-placement ([04](04-calibration.md)).
