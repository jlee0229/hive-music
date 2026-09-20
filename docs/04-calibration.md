# HiveMusic — Calibration

Owner: backend agent (engine, server, rig); frontend agent (Host · Calibrate and Player · Calibrating screens)

Output latency is the one error term we cannot read reliably from the browser, so we estimate it in two tiers: a per-browser-family table plus a human nudge (Tier 1), and a click measurement in which the host phone listens to every player (Tier 2). The same cross-correlation code is also the measuring instrument that produces the evidence for sync gates B3/B4. Scheduling terms are defined in [03-sync-engine.md](03-sync-engine.md); messages and the `room.calibration` state in [02-protocol.md](02-protocol.md).

## Tier 1 — table + nudge

- On `JOIN`, the server sets `tableLatencyMs = STARTER_LATENCY_TABLE_MS[device.browserFamily]` (60 / 45 / 25 / 30, `null` for `other`, in which case the engine subtracts `ctx.outputLatency`).
- `compensationMs = nudgeMs + (calibratedOffsetMs ?? tableLatencyMs ?? 0)`. Positive = the device is late → the engine starts it earlier.
- **Nudge UX.** Player · Playing has a slider −100…+100 ms labelled "sounds early / sounds late" → `nudgeSelf(ms)` on release; the host's player sheet has the same slider for any player → `host.nudge(id, ms)`. The server re-plans and broadcasts; the phone applies it on the next drift check.
- **"Tap when you hear the click"** (Tier 1 assist; assumption on the exact UX, not on the plan's critical path). The host phone plays the click train of `synthetic-60s` (`clickTimesSec`, one per beat at 120 BPM) and a player taps in time on their own phone; the median of `tapTime − clickTime` minus the player's reaction baseline (measured by tapping to their own screen flash first) becomes the initial `nudgeMs`. Resolution ≈ ±5 ms at best: it primes the slider; it is not a measurement.

Tier 1 lands at B4 and stays the fallback if B8/F7 are cut.

## Tier 2 — the host phone as listener

The host phone does not play (if its speaker toggle is on it is still the reference and is excluded from the click order). It opens the microphone, each player emits one click in turn on the shared clock, and the recording says how late each phone really is **relative to the others**.

### Flow

| # | Who | Action |
|---|---|---|
| 1 | host UI | Calibrate screen: "Quiet, please." → `host.startCalibration()` → `CALIBRATION_START {referenceClientId: me.id}` (the mic permission prompt appears here; explain it first) |
| 2 | server | `order` = clients with `plays:true` except the reference, by `joinIndex`; `startServerTime = now + CALIBRATION_COUNTDOWN_MS (3000)`; `room.calibration = {state:'countdown', referenceClientId, startServerTime, order, results:{}}`; broadcast |
| 3 | server → reference | `CALIBRATION_PLAN {startServerTime, intervalMs: 400, order, clickSpec: DEFAULT_CLICK_SPEC}` |
| 4 | server → player k | `SCHEDULED_ACTION {serverTimeToExecute: startServerTime + k·400, action:{kind:'CALIBRATION_CLICK', clickId: '<id>:<k>', clickSpec}}` |
| 5 | reference engine | `calibration.runAsReference({onProgress})`: `getUserMedia({audio:{echoCancellation:false, autoGainControl:false, noiseSuppression:false}})`; record from `startServerTime − 200 ms` to `startServerTime + order.length·400 + 400 ms` through an `AudioWorkletNode` (assumption; `ScriptProcessorNode` fallback); `onProgress` phases `countdown → listening (currentClientId, done/total) → analysing → done \| failed` |
| 6 | player k engine | `renderClick(clickSpec, ctx.sampleRate)`; schedules it at `ctxTimeFor(serverTimeToExecute) − compensationMs/1000` (no `delayMs`) on a dedicated `GainNode` outside the pattern chain at `clickSpec.gain`; emits `calibrationClick(serverTimeToExecute)` so Player · Calibrating flashes |
| 7 | server | at `startServerTime`: `calibration.state = 'running'`; broadcast |
| 8 | reference engine | matched filter → arrival per click → residual per player → confidence |
| 9 | reference → server | `CALIBRATION_REPORT {measurements:[{clientId, residualMs, confidence}]}` (≥1 entry) |
| 10 | server | for each measurement with `confidence ≥ 0.5` (the `index.ts` contract): `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs ?? lastReportedOutputLatencyMs ?? 0) + residualMs`. The `outputLatencyMs` term matters for a phone with no table row (`browserFamily: 'other'`): the engine was subtracting `ctx.outputLatency` itself while the click was measured, and writing `calibratedOffsetMs` makes it stop, so a base of 0 would leave that phone late by exactly its output latency until a second pass; `calibration.results[id] = {residualMs, confidence}`; `state = 'done'`; re-plan; `ROOM_STATE` |
| 11 | reference engine | `track.stop()` on every mic track; disconnect the worklet; the host's audio session returns to playback; `runAsReference` resolves `{measurements, diagnostics}` and `host.startCalibration()` resolves on `state: done` |

Host · Calibrate rows come from `room.calibration.results` (waiting / listening… / clear ✓ with `residualMs` and confidence); "Apply offsets" returns to Stage — the server has already applied on report. Running calibration again accumulates: residuals are corrections to the current value, so a second pass converges rather than restarting.

### The click signal

Synthesised in `@hive/sync-client` (`calibration.renderClick`) from `clickSpec` — never a fixture — so player and reference build bit-identical templates at their own sample rates:

```
DEFAULT_CLICK_SPEC = { kind: 'click', burstMs: 2, chirpFromHz: 2000, chirpToHz: 6000, chirpMs: 20, gain: 0.8 }   // messages.ts
signal(t) = burst : white noise, 2 ms, Hann window, seeded PRNG (same noise everywhere — assumption)
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
residual_k = raw_k − median(raw_j for j with conf_j ≥ 0.5)
```

`residual_k > 0`: player k's click reached the host later than the group's did → the device is late → its compensation grows. Every measurement is reported (the UI shows low-confidence rows as "not heard"); the server applies those with `confidence ≥ 0.5`.

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

## Timing budget for a Tier 2 run

| Players | Countdown (3.0 s) | Clicks (`N × 400 ms`) | Tail (0.4 s) | Total |
|---|---|---|---|---|
| 3 | 3.0 s | 1.2 s | 0.4 s | 4.6 s |
| 6 | 3.0 s | 2.4 s | 0.4 s | 5.8 s |
| 12 | 3.0 s | 4.8 s | 0.4 s | 8.2 s |
| 20 | 3.0 s | 8.0 s | 0.4 s | 11.4 s |

Short enough that "Quiet, please" is realistic even at 20 phones. The recording buffer is `total × sampleRate` floats (≈ 0.55 M samples at 48 kHz for 20 players) — trivial.

## Failure modes

| Failure | Detection | Handling |
|---|---|---|
| Mic permission denied / `getUserMedia` throws | promise rejects | `runAsReference` rejects; the engine reports nothing; the server marks `calibration.state = 'failed'` when no report arrives by `startServerTime + N·400 + 5000` ms (assumption); Calibrate shows retry copy |
| `getUserMedia` needs a gesture (iOS Safari) | rejects outside a tap | the Calibrate button's tap handler calls `host.startCalibration()` and the engine opens the mic in that same handler, before the countdown (assumption) |
| A click is not found (`confidence < 0.5`) | matched filter | reported with its low confidence, not applied; the results row shows "not heard — move closer, run again" |
| A player disconnects mid-run | `connected:false` in `ROOM_STATE` | its slot still fires silently on the reference side; residual omitted from the report |
| Loud room / music still playing | many low-confidence rows | the UI disables Calibrate while `transport.state === 'playing'`; the host pauses first (assumption) |
| Host has `plays:true` | server `order` excludes the reference | the host's own offset is unchanged; nudge it if it plays |
| Fewer than 2 players | median of one | residuals are 0; the UI says "needs at least two phones" and does not start (assumption) |
| Reference's `AudioContext` is `locked` | `audio.state` | the Calibrate tap doubles as `audio.unlock()` for the host; the worklet runs in that context |
| Second run after a first | accumulation | residuals are corrections to the current value; a converged room shows residuals near 0 |
| A run measured the wrong thing (phone in a pocket, click matched to a sidelobe) | the offset is far from the phone's table row, or `syncErrMs` got worse | **`CALIBRATION_RESET`** (v3, host only): clears `calibratedOffsetMs` to `null` for one client or the whole room. Re-running calibration is *not* the fix, because a wrong offset is the accumulation base for the next run |

### Undoing a run — `CALIBRATION_RESET` (v3)

Accumulation is the reason this needs its own message rather than a "calibrate again" button. A residual
is a *correction to the compensation the phone was already applying*, so a run on top of a 40 ms mistake
converges to 40 ms wrong; only clearing the base recovers.

Three rules the server must hold to:

1. **Clear to `null`, never `0`.** Null falls back through `tableLatencyMs` and then the phone's own
   `ctx.outputLatency`. Zero is a positive claim that the phone has no output latency, which is never
   true — a reset must not be worse than never having calibrated.
2. **Refuse while a run is in flight** (`calibration.state !== "idle"`, `done` included, since the
   reference's report may still be on the wire): answer `ERROR` code `CALIBRATION_BUSY`. The residuals in
   that report were measured against the compensation the phones applied *at click time*; clearing the
   base in between would add them to a different base and write in exactly the error being removed.
   Cancel first, then reset.
3. **Replan after clearing**, because each client's `assignment.compensationMs` is derived from the
   offsets. The engine needs no code for a reset: a compensation change over `RESYNC_THRESHOLD_MS`
   reschedules and a smaller one is slewed by the drift check, which is the B4 rule already. A reset the
   phone does not act on would be a control that lies — `packages/sync-client/src/__tests__/calibration-reset.test.ts`
   pins it at the reset boundary.

## Implementation notes

- **Cost.** Direct time-domain cross-correlation is enough: a 300 ms window at 48 kHz is 14 400 samples, the template is ~1 056 samples (22 ms) → ~15 M multiply-adds per click, under 20 ms in plain JavaScript. No FFT, no WASM, no worker required; run it after the recording ends, not live.
- **Normalisation.** Normalise the template to unit energy once; normalise each window position by the local energy of the recording segment (sliding sum of squares) so a loud phone does not out-vote a quiet one. Confidence uses the normalised correlation, so it is comparable across players.
- **Resampling.** The template is synthesised at the reference's `ctx.sampleRate` (44.1 or 48 kHz); players synthesise at their own rate. Speaker and mic responses smear the burst but the chirp keeps the peak sharp.
- **Timestamps.** The worklet reports `currentTime` of its first processed frame; `recordingStartServerTime = clockOffsetMs + (firstFrameCtxTime − localToCtx)·1000` using the mapping in [03](03-sync-engine.md#servertime--audiocontext-mapping). This is only used to place the ±150 ms windows.
- **Tests** (`packages/sync-client/src/calibration/xcorr.test.ts`): build a synthetic recording from `renderClick` at known offsets + pink noise; assert residuals within 1 ms and confidence ≥ 0.8; a second case with one click missing asserts its confidence < 0.5 and the others unaffected; a third case adds a +7.3 ms delay on one player and checks the sign of the residual.
- **Diagnostics.** `CalibrationResult.diagnostics` carries per-click `{rough, arrival, peak, secondPeak}` so the B8 evidence file is the raw peak-picking output, not a screenshot.

## The measurement rig (dev tool, built first)

`packages/sync-client/src/calibration/xcorr.ts` (the matched filter above, pure TypeScript on `Float32Array`, no DOM) is shared by the app and by a CLI (paths are assumptions; the backend agent owns them):

```
bun packages/sync-client/rig/measure.ts --wav recording.wav --meta fixtures/tracks/synthetic-60s/meta.json [--from 0 --to 30] [--phones 2]
→ per click in clickTimesSec: the N strongest peaks in a ±100 ms window and their spread; mean and sd of the spread over the range
```

How it produces evidence for B3/B4:

1. Play `synthetic-60s` in UNISON on two phones. The rig runs on the backend agent's dev machine with a laptop mic (or on the host phone via the same code).
2. `meta.json` gives `clickTimesSec` — one click per beat (every 0.5 s at 120 BPM) in the **drums** stem (a 2 ms 2 kHz burst plus a 40 ms noise tail; eighth-note hits after the 30 s drop). Since every phone plays the same clicks, each window contains one peak per phone; the rig reports the spread between the strongest N peaks. Peaks closer than ~1 ms merge into one, which counts as a pass. To attribute a peak to a phone, nudge that phone by a known amount (this is exactly the B4 "+40 ms → 40±3 ms" check) or pin the other phones to non-drum roles in ORCHESTRA.
3. Record 30 s at t=0 and again at t=5 min; the rig prints device-to-device spread. B3 passes at <10 ms after table compensation; B4 at <10 ms at both times.

Evidence goes to `evidence/backend/` as the rig's text output (`B3-rig-t0.txt`, `B4-rig-t5min.txt`); WAVs are gitignored, so a one-line `.md` names the recording. `STARTER_LATENCY_TABLE_MS` is corrected from these numbers.

## Screens driven by this flow

| Screen | `room.calibration.state` | Shows | Engine / messages |
|---|---|---|---|
| Host · Calibrate | idle | "Quiet, please.", player count, Calibrate button (disabled while playing) | — |
| Host · Calibrate | countdown | countdown ring (3 s) | `CALIBRATION_START` sent; `CALIBRATION_PLAN` received; mic opens |
| Host · Calibrate | running | one row per player in `order`: waiting / listening… / clear ✓ | `onProgress` per click; recording |
| Host · Calibrate | done / failed | per player: residual (ms, signed), confidence, applied or "not heard"; Apply offsets → Stage; failed → retry copy | `CALIBRATION_REPORT` sent; results in `room.calibration.results` |
| Player · Calibrating | countdown / running | "Hold still. Quiet, please.", phone N of M dots | receives `SCHEDULED_ACTION` |
| Player · Calibrating | (click) | full-screen white flash timed with `calibrationClick(clickAtServerTime)` via `clock.ctxTimeFor` | plays the click |
| Player · Calibrating | done / failed / idle | back to Ready/Playing on the next `ROOM_STATE` | new `compensationMs` in the assignment |

Full screen inventory and states: [06-hive-map-ui.md](06-hive-map-ui.md). The `calibrating` mock scenario (6 players, `state: running`, 2 results) renders the running state without a microphone.

## Stretch — BeepBeep two-way ranging for auto-placement

Each pair of phones exchanges clicks and both record; the difference of the two recorded intervals cancels clock offsets and latencies (Peng et al., SenSys 2007) and yields distance to 1–2 cm. Three or more anchors give positions for the Hive Map without dragging. Only after B8, and only before playback: recording on a player changes its iOS audio session, so it cannot run during the show.

## Related

- [03-sync-engine.md](03-sync-engine.md) — `compensationMs`, `ctxTimeFor()`, the latency table this calibration corrects
- [02-protocol.md](02-protocol.md) — `CALIBRATION_START` / `CALIBRATION_PLAN` / `SCHEDULED_ACTION` / `CALIBRATION_REPORT` and `room.calibration`
- [06-hive-map-ui.md](06-hive-map-ui.md) — Host · Calibrate and Player · Calibrating screens
- [08-roadmap.md](08-roadmap.md) — gates B8 / F7 and their place in the cut list
