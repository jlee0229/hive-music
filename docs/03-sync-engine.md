# HiveMusic — Sync Engine (`@hive/sync-client`)

Owner: backend agent

`@hive/sync-client` is the headless browser engine: WebSocket + reconnect, clock model, AudioContext, stem preload, scheduling, drift correction, pattern gain automation, calibration click emit/listen, device detection. `apps/web` never creates its own AudioContext or WebSocket; it calls this API through the `useHiveClient` hook it owns. The public API is frozen at IC0; the stub on `main` (`packages/sync-client/src/index.ts`) throws "not implemented" until B2–B4 fill it in. Wire contract: [02-protocol.md](02-protocol.md). Calibration internals: [04-calibration.md](04-calibration.md).

## Public API (frozen at IC0)

```ts
createHiveClient({ wsUrl, apiUrl, roomCode, kind, plays, hostKey?, name? })
  → connect() / disconnect()
  → on('state' | 'health' | 'status' | 'error' | 'connection' | 'audio', handler)
  → room                       // latest RoomState from ROOM_STATE
  → me                         // room.clients[myClientId]
  → connection: 'connecting' | 'open' | 'reconnecting' | 'closed'
  → audio: 'locked' | 'unlocked' | 'loading' | 'ready'
  → loadProgress               // 0..1 across all stems of room.track
  → audio.unlock()             // must be called inside a user gesture
  → clock.serverNow()          // ms on the server clock
  → clock.trackTimeSec()       // derived from room.transport
  → status { clockOffsetMs, rttMs, syncErrMs, outputLatencyMs, compensationMs }
  → host.{ play, pause, seek, setMode, assign, setPosition, nudge, setPlays, startCalibration, vibe }
  → calibration.runAsReference({ onProgress })
  → detectDevice()
```

Events: `state` (new `room`), `health` (hosts only, from `HEALTH`), `status` (any `status` field changed), `error` (`ERROR` message or local failure), `connection` (connection state changed), `audio` (audio state or `loadProgress` changed).

Notes on the shape:

- The plan lists both `audio` (a state string) and `audio.unlock()`. (assumption) The stub implements `audio` as `{ state, unlock() }` where `state` is the string above, and the `audio` event carries `{ state, loadProgress }`. If the stub on `main` differs, the stub wins and this doc is corrected.
- `host.*` methods send the corresponding message: `play(trackId?, trackTimeSec?)`, `pause()`, `seek(trackTimeSec)` → `TRANSPORT`; `setMode(mode, params)` → `SET_MODE`; `assign(clientId, role|null)` → `ASSIGN`; `setPosition(clientId, x, y)` → `SET_POSITION` (the UI throttles to 10 Hz); `nudge(clientId, nudgeMs)` → `NUDGE`; `setPlays(plays)` → `SET_PLAYS`; `startCalibration()` → `CALIBRATION_START {referenceClientId: me.id}`; `vibe(prompt)` → `POST /rooms/:code/vibe`.
- (assumption) The player's own nudge slider calls `host.nudge(me.id, ms)`; the server accepts `NUDGE` from a non-host only for its own `clientId`. See PR-000 in [PROTOCOL-REQUESTS.md](PROTOCOL-REQUESTS.md).
- `detectDevice()` → `{userAgent, platform, browserFamily, model?}` with `browserFamily ∈ 'ios-safari' | 'android-chrome' | 'desktop-chrome' | 'desktop-safari' | 'other'` (these are the keys of `STARTER_LATENCY_TABLE_MS`).
- `calibration.runAsReference` resolves when the `CALIBRATION_REPORT` has been sent and the mic released; `onProgress({done, total, clientId})` fires per click.

## Sign conventions

| Quantity | Definition | Positive means |
|---|---|---|
| `clockOffsetMs` | `serverTime − performance.now()` | server clock reads ahead of the local monotonic clock |
| `estServerNow` | `performance.now() + clockOffsetMs` | — |
| `compensationMs` | `nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0)`, computed server-side | device is late → start it earlier |
| `nudgeMs` | slider; "I sound late" → positive | advance this phone |
| `delayMs` | from the assignment (WAVE) | play this phone later |
| `residualMs` | calibration ([04](04-calibration.md)) | click arrived late → add to compensation |

All wire times are ms floats on the server clock. AudioContext times are seconds. Never use `Date.now()` for timing; use `performance.now()`.

## Clock model (NTP client)

Per probe: `t0` client send (`performance.now()`), `t1` server receive, `t2` server send, `t3` client receive.

```
offset = ((t1 − t0) + (t2 − t3)) / 2      // serverTime − clientTime
rtt    = (t3 − t0) − (t2 − t1)
```

Probe schedule and selection:

| Aspect | Rule |
|---|---|
| Burst | 20 probes in the first 4 s after `WELCOME` (10 coded pairs, one pair every 400 ms — assumption on pairing). The burst result is applied as a step before any audio is scheduled. |
| Steady state | 1 Hz (one coded pair per second — assumption). |
| Coded probe pairs | Each pair shares `probeGroupId`; `probeGroupIndex ∈ {0,1}`; departures spaced by a known gap `g` (assumption: 10 ms). The server returns `t1`/`t2` per probe. If `\|(t1[1] − t1[0]) − (t0[1] − t0[0])\| > 2 ms` (assumption on tolerance) the pair was queued on the path and both measurements are rejected. |
| Window | Sliding window of the last 30 accepted probes. |
| Selection | The probe with minimum `rtt` in the window: its `offset` is the estimate, its `rtt` is `minRttMs`. |
| Application | If `\|estimate − applied\| > 10 ms`: step immediately (the drift check then resyncs the audio). Else slew `clockOffsetMs` toward the estimate at ≤2 ms/s (assumption). A +50 ppm local-clock drift is 0.05 ms/s, far inside the slew rate, so `estServerNow` stays within the ±2–5 ms budget indefinitely (B4). |
| Reconnect | Keep the applied offset; restart the burst; keep the old window until 10 new probes are accepted (assumption). |

B2 acceptance: fake transport with +137 ms offset, ±30 ms jitter, 20 % spikes → estimate within 2 ms after 30 probes.

## serverTime ↔ AudioContext mapping

In the same synchronous tick as every probe send, sample `(performance.now(), ctx.currentTime)` and keep the last 10 pairs:

```
perfToCtx = median(ctx.currentTime − performance.now() / 1000)          // seconds
ctxAt(S)  = perfToCtx + (S − clockOffsetMs) / 1000                       // any server time S → ctx seconds
          ≈ ctx.currentTime + (S − estServerNow) / 1000                   // identical when read in one tick
```

The one-tick form is the plan's scheduling formula; the sampled form is used by the drift check and by calibration timestamps. Unit test (B3): a synthetic `(perf, ctx)` series with +50 ppm drift and 5 ms jitter maps a server time to within 2 ms.

## Transport-derived scheduling

The server sets on PLAY:

```
serverTimeAtTrackZero = now + LEAD_MS − trackTimeSec · 1000      // LEAD_MS = 600
```

Every phone must emit track position `p` (seconds) from its speaker at server time `S(p) = serverTimeAtTrackZero + p·1000 + delayMs`. Sound leaves the speaker `compensationMs` after the ctx time we schedule, so (the plan's formula, with `serverTime = serverTimeAtTrackZero + p·1000`):

```
ctxTime = ctx.currentTime
        + (serverTime − estServerNow) / 1000
        + delayMs / 1000
        − compensationMs / 1000
        − (tableLatencyMs == null && calibratedOffsetMs == null ? (ctx.outputLatency || 0) : 0)
```

**Start from zero (worked example).** `estServerNow = 1 000 000.0`, `ctx.currentTime = 12.000`. PLAY was issued at `999 850` with `trackTimeSec = 0` → `serverTimeAtTrackZero = 999 850 + 600 = 1 000 450`. UNISON (`delayMs = 0`), iOS Safari with no calibration → `compensationMs = 0 + 45 = 45`.

```
ctxTime = 12.000 + (1 000 450 − 1 000 000) / 1000 + 0 − 0.045 = 12.405
for each stem: source.start(12.405, 0)
```

**Late join / resume (worked example).** Same room, `estServerNow = 1 030 000` (the start is 29.55 s in the past), `ctx.currentTime = 42.000`. Pick `ctxStart = ctx.currentTime + 0.050` (50 ms safety margin, assumption) and solve for the offset into the track:

```
p = (estServerNow + 50 − serverTimeAtTrackZero − delayMs + compensationMs) / 1000
  = (1 030 000 + 50 − 1 000 450 − 0 + 45) / 1000 = 29.645
for each stem: source.start(42.050, 29.645)
check: position 29.645 leaves the speaker at ctx 42.050 + 0.045 = 42.095
       → server time 1 030 095 = S(29.645) = 1 000 450 + 29 645 ✓
```

`clock.trackTimeSec()`:

```
playing: (estServerNow − serverTimeAtTrackZero) / 1000
paused:  trackTimeAtPause
stopped: 0                     // (assumption: 'stopped' is the initial transport state)
```

Rules:

- All stems start in one synchronous sequence with the identical `when`; each stem has its own `GainNode` (dB → linear `10^(dB/20)`), summed into a pattern `GainNode`, then a master `GainNode` → `ctx.destination`. Mute = master gain 0.
- A `ROOM_STATE` whose `(track.id, transport.state, serverTimeAtTrackZero, trackTimeAtPause)` tuple differs from the last applied one is a transport change: `paused`/`stopped` → stop sources with a 10 ms fade (assumption); `playing` → schedule as above (immediately if the start is already past).
- A change in `compensationMs` or `delayMs` while playing changes the target position; the drift check picks it up and resyncs if the change exceeds 10 ms, otherwise the residual is carried until the next resync (v1 accepts this; slewing is stretch).
- New `gainsDb` ramp with `linearRampToValueAtTime` over 50 ms (assumption), starting at `ctxAt(applyAtServerTime)` when present and in the future, else now.

## Drift check and hard resync

Every 1 s while playing — and immediately on a transport change, a clock step, `visibilitychange` → visible, or `statechange` → running — once `ctx.currentTime ≥ startCtxTime`:

```
emittedNow = startOffsetSec + (ctx.currentTime − startCtxTime) − compensationMs / 1000
             [− outputLatency in the no-table/no-calibration case]     // position leaving the speaker now
targetNow  = (estServerNow − serverTimeAtTrackZero − delayMs) / 1000   // position that should be leaving it
errorMs    = (emittedNow − targetNow) · 1000                            // positive = this phone is ahead
```

If `|errorMs| > 10 ms`: create new sources at the corrected position starting at `ctx.currentTime + 0.05`, crossfade **20 ms** (old branch gain 1→0, new branch 0→1, linear), stop the old sources after the fade. Record `lastAppliedCorrectionMs = errorMs`. If `|errorMs| ≤ 10 ms`: no audio change, but `lastAppliedCorrectionMs = errorMs` is still recorded (assumption) so the health number reports the real residual rather than 0.

```
syncErrMs := minRttMs / 2 + |lastAppliedCorrectionMs|
```

An upper bound on how far this phone may be from the server timeline. It drives `healthLevel`: good ≤5 ms, warn ≤20 ms, bad >20 ms; unknown when `lastSeen` >5 s. The phone reports it in `CLIENT_STATUS` every 2 s; hosts see it in `HEALTH` at 1 Hz.

B4 acceptance: rig at t=0 and t=5 min both <10 ms device-to-device; a +40 ms nudge shifts the measured click by 40±3 ms; simulated +50 ppm clock drift keeps the clock estimate within 5 ms.

## Audio state machine, unlock sequence, iOS

```
locked ──audio.unlock() in a gesture──▶ unlocked ──track known──▶ loading ──all stems decoded──▶ ready
   ▲                                                                                          │
   └────── ctx.state became 'interrupted'/'suspended' and resume() was refused (no gesture) ──┘
```

`audio.unlock()` runs inside the tap handler, synchronously before any `await`:

1. Create the `AudioContext` once (`{ latencyHint: 'interactive' }`, default sample rate).
2. `if ('audioSession' in navigator) navigator.audioSession.type = 'playback'` — Safari 17+, feature-guarded; without it the iOS silent switch mutes Web Audio.
3. `await ctx.resume()`.
4. Start a one-sample silent buffer (`source.start(0)`) to satisfy WebKit's gesture requirement.
5. Read `ctx.outputLatency` (may be `undefined` → `status.outputLatencyMs = null`).

Stems: when `room.track` is known and the state is `unlocked`, fetch every `GET /audio/:trackId/:stem.wav` in parallel, `decodeAudioData` each, keep the `AudioBuffer`s (≤4 × 60 s mono ≈ 42 MB as Float32). `loadProgress` = bytes received / total, with decode counted as the final 5 % (assumption). When **every stem is decoded** send `AUDIO_READY {trackId}` and set `ready`. `AUDIO_READY` never means "first stem playable". The server records it in the client's health record (assumption); it never blocks `PLAY` — a phone that becomes ready after `PLAY` late-joins through the normal path.

Interruptions: iOS moves the context to `'interrupted'` on lock screen or call; Android to `'suspended'` on backgrounding. On `statechange` → running or `visibilitychange` → visible, run the drift check immediately (it will resync). If `ctx.resume()` rejects outside a gesture, set `audio` to `locked` with buffers retained; the UI shows "Tap to resume" and the next `audio.unlock()` returns straight to `ready`. Wake Lock (`navigator.wakeLock.request('screen')`, HTTPS) is requested by `apps/web` after unlock (F3) and re-requested on `visibilitychange` → visible. Never call `getUserMedia` on a playing phone: it switches iOS into play-and-record and changes volume and latency — calibration listening runs only on the non-playing host phone.

Reconnect: on close, `connection = 'reconnecting'`, backoff 0.5 → 4 s (assumption); re-`JOIN` with the same `clientId`; the next `ROOM_STATE` re-derives everything from `transport`. Server-restart recovery within 5 s is a B3 check. Heartbeat: answer every `PING` with `PONG`.

## Latency table (Tier 1)

`tableLatencyMs` by `browserFamily`, applied server-side when `calibratedOffsetMs` is null. Only the **differences** between rows matter — a common offset shifts every phone equally. Starter guesses; measure with the rig ([04](04-calibration.md)) and replace before B4 is signed off:

| browserFamily | tableLatencyMs | Note |
|---|---|---|
| `ios-safari` | 60 | `outputLatency` unreliable (WebKit FIXME); starter guess; calibrate |
| `android-chrome` | 45 | 20–100+ ms spread across devices; starter guess; calibrate |
| `desktop-chrome` | 25 | starter guess; calibrate |
| `desktop-safari` | 30 | starter guess; calibrate |
| `other` | null | client subtracts `ctx.outputLatency \|\| 0` instead |

Nudge semantics: `NUDGE {clientId, nudgeMs}`, whole ms, clamped to ±100 (`NUDGE_RANGE_MS`). The server recomputes `compensationMs` and broadcasts; the phone applies it through the drift check. The player slider reads "I sound early ↔ late"; late → positive → advance. The host's tap-a-dot sheet has the same slider for any player.

## Pattern evaluation on the shared clock

For an assignment with `pattern`, the engine evaluates `evaluatePattern(pattern, trackTimeMs)` from `@hive/protocol` and schedules gain automation one period ahead on the pattern `GainNode` (5 ms edge ramps — assumption), keyed off `clock.trackTimeSec()`. No per-tick messages; the UI evaluates the same function per frame for the screen. The audio multiplier applies for `kind:'strobe'`; for `kind:'wave'` it is used by the screen only (assumption — see [05-effect-modes.md](05-effect-modes.md)).

## Error budget (mechanism view)

| Term | Mechanism | Budget |
|---|---|---|
| Clock | min-RTT over 30 probes, coded pairs, slewed application | ±2–5 ms |
| Output latency | table → nudge → Tier 2 | ±10–20 → ±5 → ±2–3 ms |
| Scheduling | `source.start(when)` at a computed ctx time; 128-sample render quantum | ≤3 ms |
| Drift | hard resync at >10 ms, 20 ms crossfade | ≤10 ms transient, ~0 after |
| Total after Tier 2 | RSS | ~4–7 ms vs the ≤10 ms target; ≤30 ms floor |

Full table with per-mode needs: [00-context.md](00-context.md#error-budget).

## Testing hooks

- The clock model takes an injectable transport (`send(t0) → Promise<{t1,t2}>`) so B2 runs under `bun test` with a fake network.
- The scheduler takes an injectable `ctx`-like object (`currentTime`, `createBufferSource`, `createGain`) for the B3 mapping test.
- `/diag` in `apps/web` shows `ctx.state`, `sampleRate`, `outputLatency`, `clockOffsetMs`, `rttMs`, `syncErrMs`, unlock state, wake lock, `audioSession` — the F1 checklist reads from `status` and the `audio` event.

## Stretch (after B8)

- `playbackRate` slewing (±0.5 %) to remove drift without crossfades.
- Crowd-sourced latency table: calibration residuals per `device.model` aggregated server-side.
- BeepBeep two-way ranging for auto-placement ([04](04-calibration.md)).
