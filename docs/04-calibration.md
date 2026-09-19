# HiveMusic — Calibration

Owner: backend agent (engine, server, rig); frontend agent (Host · Calibrate and Player · Calibrating screens)

Output latency is the one error term we cannot read reliably from the browser, so we estimate it in two tiers: a per-browser-family table plus a human nudge (Tier 1), and a click measurement in which the host phone listens to every player (Tier 2). The same cross-correlation code is also the measuring instrument that produces the evidence for sync gates B3/B4. Scheduling terms are defined in [03-sync-engine.md](03-sync-engine.md); messages in [02-protocol.md](02-protocol.md).

## Tier 1 — table + nudge

- On `JOIN`, the server maps `device.browserFamily` to `tableLatencyMs` (four starter rows in [03](03-sync-engine.md#latency-table-tier-1); `null` for unknown families, in which case the client subtracts `ctx.outputLatency`).
- `compensationMs = nudgeMs + (calibratedOffsetMs ?? tableLatencyMs)`. Positive = the device is late → the engine starts it earlier.
- **Nudge UX.** Player · Playing has a small slider "I sound early ↔ late"; the host's tap-a-dot sheet has the same slider for any player. Moving it sends `NUDGE {clientId, nudgeMs}`; the server re-plans and broadcasts; the phone applies it on the next drift check.
- **"Tap when you hear the click"** (Tier 1 assist; assumption on the exact UX). The host phone plays a click train (the `synthetic-60s` click times from `meta.json`, or the synthesised click below at 1 Hz) and a player taps in time on their own phone; the median of `tapTime − clickTime` minus the player's reaction baseline (measured by tapping to their own screen flash first) becomes the initial `nudgeMs`. Resolution ≈ ±5 ms at best: it primes the slider; it is not a measurement.

Tier 1 lands at B4 and stays the fallback if B8/F7 are cut.

## Tier 2 — the host phone as listener

The host phone does not play (if the speaker toggle is on, the host is still the reference and is excluded from the click order — assumption). It opens the microphone, each player emits one click in turn on the shared clock, and the recording says how late each phone really is **relative to the others**.

### Flow

| # | Who | Action |
|---|---|---|
| 1 | host UI | "Quiet, please" → 3 s countdown → `host.startCalibration()` → `CALIBRATION_START {referenceClientId: me.id}` |
| 2 | server | `order` = connected clients with `plays:true`, sorted by `joinIndex`, reference excluded (assumption); `startServerTime = now + 1500` (assumption); `intervalMs = 400`; `clickSpec` below |
| 3 | server → reference | `CALIBRATION_PLAN {startServerTime, intervalMs, order, clickSpec}` |
| 4 | server → player k | `SCHEDULED_ACTION {serverTimeToExecute: startServerTime + k·intervalMs, action:{type:'CALIBRATION_CLICK', clickId}}` |
| 5 | reference engine | `calibration.runAsReference({onProgress})`: `getUserMedia({audio:{echoCancellation:false, autoGainControl:false, noiseSuppression:false}})`; record from `startServerTime − 200 ms` to `startServerTime + order.length·intervalMs + 400 ms` through an `AudioWorkletNode` (assumption; `ScriptProcessorNode` fallback) |
| 6 | player k engine | Synthesises the click from `clickSpec`; schedules it with the normal formula (`delayMs = 0`, its current `compensationMs`, fixed gain from `clickSpec` on a separate `GainNode`) at `ctxAt(serverTimeToExecute)`; emits an `audio`-independent `calibrationClick` UI hint so Player · Calibrating flashes (assumption: exposed through the `state` event's room snapshot or a dedicated callback — see [06](06-hive-map-ui.md)) |
| 7 | reference engine | Matched filter → arrival per click → residual per player → confidence; `onProgress` per click drives the per-player progress ring |
| 8 | reference → server | `CALIBRATION_REPORT {measurements:[{clientId, residualMs, confidence}]}` |
| 9 | server | For each measurement with `confidence ≥ 0.3` (assumption): `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs) + residualMs`; re-plan; `ROOM_STATE` |
| 10 | reference engine | `track.stop()` on every mic track; disconnect the worklet; the host's audio session returns to playback |

Results screen: per player the residual, the confidence and a filled ring; "Apply" confirms and returns to Stage (the server has already applied on report — assumption on wording). Running calibration again accumulates: residuals are corrections to the current value, so a second pass converges rather than restarting.

### The click signal

Synthesised in `@hive/sync-client` from `clickSpec` — never a fixture — so player and reference build bit-identical templates at their own sample rates:

```
clickSpec = { kind: 'click-chirp', burstMs: 2, chirpMs: 20, chirpFromHz: 2000, chirpToHz: 6000, gain: 0.8 }   // (assumption on values)
signal(t) = burst : white noise, 2 ms, Hann window, seeded PRNG (same noise everywhere)
          + chirp : linear sweep 2 → 6 kHz over 20 ms, Hann window, starting at t = 2 ms
```

2–6 kHz is where phone speakers are efficient and mics are flat; the 2 ms burst gives a sharp correlation peak; the chirp adds energy so the peak survives room noise. Total length 22 ms ≪ `intervalMs` 400.

### Matched filter and residuals

```
for each click k in order:
  rough_k  = (startServerTime + k·intervalMs) − recordingStartServerTime   // ms into the recording, via the host's clock (±5 ms is fine)
  window   = [rough_k − 150 ms, rough_k + 150 ms]                          // < intervalMs / 2, so neighbours never enter
  xc       = normalised cross-correlation(recording[window], template)
  peak_k   = argmax(xc)  →  arrival_k (ms into the recording; sample resolution ≈ 0.02 ms at 48 kHz)
  conf_k   = clamp(1 − secondPeak / peak, 0, 1)   // second peak searched outside ±2 ms of the main peak
raw_k      = arrival_k − k·intervalMs
residual_k = raw_k − median(raw_j for j with conf_j ≥ 0.3)
```

`residual_k > 0`: player k's click reached the host later than the group's did → the device is late → its compensation grows. Measurements with `conf < 0.3` are reported but not applied (assumption on the threshold; the rig tunes it).

### Why relative offsets suffice

Every click passes through the same host microphone, the same input latency, the same worklet buffering and the same recording clock. Those terms add one constant `c` to every `raw_k`; subtracting the group median removes `c` exactly. The host phone's own clock offset and input latency therefore never enter the result — only the rough window placement uses the host's clock, and a 5 ms error there is irrelevant to a ±150 ms window. Absolute latency is unknowable from the browser and unnecessary: unison only needs the phones to agree with each other. With a single player the residual is 0 by construction.

### Propagation and "hold phones near the host"

Sound travels ~2.9 ms per metre. A player 2 m from the host measures 5.8 ms late even when perfectly synced. Instruction on the Calibrate screen: **"Everyone hold your phone up near the host — within arm's reach."** At ≤1 m the propagation error is ≤2.9 ms and roughly equal for all, so most of it cancels in the median. This is why the Tier 2 row of the error budget says ±2–3 ms and not ±0.5 ms.

### Acceptance (gate B8)

| Check | Pass |
|---|---|
| Synthetic: a generated "recording" with 6 clicks at `k·400 ms`, one delayed by +7.3 ms, pink noise at −20 dB | that player's residual within **1 ms** of +7.3; the others within 1 ms of 0; every `confidence ≥ 0.8` |
| Real: host phone listening, 3 players, one with a `+40 ms` nudge | that player's residual ≈ −40 ms, recovered within **±5 ms**; after apply the rig shows the three phones within 10 ms |
| Mic released | every `MediaStreamTrack.readyState === 'ended'` after the report; host `/diag` shows `audioSession` back to `playback` |

Sign check for the real test: a `+40 ms` nudge advances the phone, so its click arrives 40 ms early → `residual ≈ −40` → `calibratedOffsetMs = table − 40` → `compensationMs = 40 + table − 40 = table`. Recovered.

## The measurement rig (dev tool, built first)

`packages/sync-client/src/calibration/xcorr.ts` (the matched filter above, pure TypeScript on `Float32Array`, no DOM) is shared by the app and by a CLI:

```
bun packages/sync-client/rig/measure.ts --wav recording.wav --meta fixtures/synthetic-60s/meta.json [--from 0 --to 30]
→ per stem (= per phone in ORCHESTRA): arrival − expected for each click, mean, sd; pairwise device-to-device skew
```

How it produces evidence for B3/B4:

1. Play `synthetic-60s` on two phones. The rig runs on the backend agent's dev machine with a laptop mic (or on the host phone via the same code).
2. `meta.json` carries each stem's click times. (assumption) `gen-synthetic.ts` places each stem's clicks at a distinct phase — drums at `2n s`, bass at `2n + 0.5`, vocals `2n + 1`, other `2n + 1.5` — so that in ORCHESTRA every phone's clicks are separable. If the generator instead uses identical click times, the rig reports the spread between the two largest peaks in each window (a single merged peak means <2 ms).
3. Record 30 s at t=0 and again at t=5 min; the rig prints device-to-device skew. B3 passes at <10 ms after table compensation; B4 at <10 ms at both times, with the `+40 ms` nudge showing as a 40±3 ms shift.

Evidence goes to `evidence/backend/` as the rig's text output plus the WAV. The table in [03](03-sync-engine.md#latency-table-tier-1) is corrected from these numbers.

## Stretch — BeepBeep two-way ranging for auto-placement

Each pair of phones exchanges clicks and both record; the difference of the two recorded intervals cancels clock offsets and latencies (Peng et al., SenSys 2007) and yields distance to 1–2 cm. Three or more anchors give positions for the Hive Map without dragging. Only after B8, and only before playback: recording on a player changes its iOS audio session, so it cannot run during the show.

## Timing budget for a Tier 2 run

| Players | Lead (assumption 1.5 s) | Clicks (`N × 400 ms`) | Tail (0.4 s) | Total mic-open time |
|---|---|---|---|---|
| 3 | 1.5 s | 1.2 s | 0.4 s | 3.1 s |
| 6 | 1.5 s | 2.4 s | 0.4 s | 4.3 s |
| 12 | 1.5 s | 4.8 s | 0.4 s | 6.7 s |
| 20 | 1.5 s | 8.0 s | 0.4 s | 9.9 s |

Short enough that "Quiet, please" is realistic even at 20 phones. The recording buffer is `total × sampleRate` floats (≈ 0.5 M samples at 48 kHz for 20 players) — trivial.

## Failure modes

| Failure | Detection | Handling |
|---|---|---|
| Mic permission denied / `getUserMedia` throws | promise rejects | `calibration.runAsReference` rejects with `code:'MIC_DENIED'`; the UI shows "Allow the microphone and try again"; no report sent; server times the session out after `startServerTime + N·400 + 5000` ms (assumption) and clears it |
| `getUserMedia` needs a gesture (iOS Safari) | rejects when called outside a tap | the host UI calls `host.startCalibration()` and the engine opens the mic inside the same Calibrate tap handler, before the countdown (assumption) |
| A click is not found (`confidence < 0.3`) | matched filter | reported with its low confidence, not applied; the results row shows "not heard — move closer, run again" |
| A player disconnects mid-run | `ROOM_STATE` `connected:false` | its slot still fires silently on the reference side; residual omitted from the report |
| Loud room / music still playing | many low-confidence rows | the UI blocks Calibrate while `transport.state === 'playing'`; the host pauses first (assumption) |
| Host has `plays:true` | server `order` excludes the reference | the host's own offset is unchanged; it is calibrated by nudge if it plays |
| Fewer than 2 players | median of one | residuals are 0; the UI says "needs at least two phones" and does not start (assumption) |
| Reference's `AudioContext` is `locked` | engine state | the Calibrate tap doubles as `audio.unlock()` for the host; the worklet runs in that context |
| Second run after a first | accumulation | residuals are corrections to the current value; a converged room shows residuals near 0 |

## Implementation notes

- **Cost.** Direct time-domain cross-correlation is enough: a 300 ms window at 48 kHz is 14 400 samples, the template is ~1 056 samples (22 ms) → ~15 M multiply-adds per click, under 20 ms in plain JavaScript. No FFT, no WASM, no worker required; run it after the recording ends, not live.
- **Normalisation.** Normalise the template to unit energy once; normalise each window position by the local energy of the recording segment (sliding sum of squares) so a loud phone does not out-vote a quiet one. Confidence uses the normalised correlation, so it is comparable across players.
- **Resampling.** The template is synthesised at the reference's `ctx.sampleRate` (44.1 or 48 kHz); players synthesise at their own rate. Speaker and mic responses smear the burst but the chirp keeps the peak sharp.
- **Timestamps.** The worklet reports `currentTime` of its first processed frame; `recordingStartServerTime = clockOffsetMs + (firstFrameCtxTime − perfToCtx)·1000` using the mapping in [03](03-sync-engine.md#servertime--audiocontext-mapping). This is only used to place the ±150 ms windows.
- **Tests** (`packages/sync-client/src/calibration/xcorr.test.ts`): build a synthetic recording from the template at known offsets + pink noise; assert residuals within 1 ms and confidence ≥ 0.8; a second case with one click missing asserts its confidence < 0.3 and the others unaffected; a third case adds a +7.3 ms delay on one player and checks the sign of the residual.
- **Player side.** The click is scheduled with `source.start(ctxAt(serverTimeToExecute) − compensationMs/1000)` on a dedicated `GainNode` outside the pattern chain, so STROBE gating never mutes a calibration click; the screen flash is driven from the same scheduled time via `setTimeout` for the UI (assumption on mechanism, see [06](06-hive-map-ui.md)).

## Screens driven by this flow

| Screen | State | Shows | Messages |
|---|---|---|---|
| Host · Calibrate | idle | "Quiet, please", player count, Start button (disabled while playing) | — |
| Host · Calibrate | countdown | 3-2-1 | `CALIBRATION_START` sent at 0 |
| Host · Calibrate | running | one ring per player in `order`, filling as `onProgress` fires | receives `CALIBRATION_PLAN`; records |
| Host · Calibrate | results | per player: residual (ms, signed), confidence, applied/not; Apply → Stage | `CALIBRATION_REPORT` sent |
| Player · Calibrating | waiting | "Hold still — hold your phone near the host" | receives `SCHEDULED_ACTION` |
| Player · Calibrating | click | full-screen flash for 200 ms at the click | plays the click |
| Player · Calibrating | done | "Thanks" then back to Ready/Playing on the next `ROOM_STATE` | new `compensationMs` in assignment |

Full screen inventory and states: [06-hive-map-ui.md](06-hive-map-ui.md).

## Related

- [03-sync-engine.md](03-sync-engine.md) — `compensationMs`, `ctxAt()`, the latency table this calibration corrects
- [02-protocol.md](02-protocol.md) — `CALIBRATION_START` / `CALIBRATION_PLAN` / `SCHEDULED_ACTION` / `CALIBRATION_REPORT`
- [06-hive-map-ui.md](06-hive-map-ui.md) — Host · Calibrate and Player · Calibrating screens
- [08-roadmap.md](08-roadmap.md) — gate B8 / F7 and their place in the cut list
