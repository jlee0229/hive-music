# B8e — Tier-2 calibration DSP, `runAsReference`, and the measurement rig

date: 2026-09-19
files: `packages/sync-client/src/calibration/{xcorr,click,reference}.ts`, `packages/sync-client/rig/{measure,synth-recording,wav}.ts`
tests: `src/__tests__/xcorr.test.ts` (13) · cmd: `bun test packages/sync-client/src/__tests__/xcorr.test.ts`

## The gate's checks

```
[B8] single click at 23.4 ms → found at 23.396 ms (err -0.004 ms, confidence 0.93)
[B8] smeared (band-limited) click at 77.5 ms → err 0.028 ms, confidence 0.92
[B8] noise with no click → confidence 0.079 (below the 0.5 cutoff, so the server ignores it)
[B8] 6 clicks, #3 late by 7.3 ms, reference latency 37.2 ms: median 37.21 ms removed, worst residual error 0.008 ms
```

| check | asked for | measured |
|---|---|---|
| synthetic recording = template delayed 23.4 ms + noise → residual | within **1 ms** | **0.004 ms** |
| two templates 300 ms apart resolved independently | resolved | ✅ both within 0.5 ms, confidence > 0.8 |
| docs/04 case: 6 clicks, one +7.3 ms, pink noise | residual within 1 ms, confidence ≥ 0.8 | **worst 0.008 ms**, all confidences > 0.8 |
| a missing click | confidence < 0.5, others unaffected | ✅ 0.08, and it did not anchor the median |
| the reference's own latency cancels | exactly | ✅ 10 ms vs 90 ms of reference latency give residuals agreeing within 0.5 ms |
| both sample rates | 44.1 and 48 kHz | ✅ within 0.1 ms at each |

The margin here is three orders of magnitude, which is worth being suspicious of rather than pleased
about — so the tests deliberately include the ways a room degrades the signal: pink noise at −20 dB, a
phone at a third of the volume, a one-pole smear standing in for a band-limited speaker and microphone,
and a click that never arrives. The accuracy holds because the chirp keeps the correlation peak sharp even
after the burst has been smeared, which is the reason the click is a burst *plus* a chirp.

## The measurement rig, and the fact that it was wrong at first

`rig/measure.ts` is the instrument the ≤10 ms claim is checked with. Two or more phones play `synthetic-60s`
in UNISON, something records the room, and the spread between the correlation peaks in each click window
*is* the device-to-device skew. No shared clock is involved on the measuring side, which is the point: the
instrument cannot inherit the error it is measuring.

**An instrument nobody has calibrated is not evidence.** So `rig/synth-recording.ts` builds recordings from
the real drums stem with phones at known offsets, and the rig has to recover them:

| synthetic phones | expected spread | rig reported | verdict |
|---|---|---|---|
| 0, 0 ms | 0 | **INCONCLUSIVE** — 14 of 16 clicks merged into one peak | correct, see below |
| 0, 4 ms | 4 | **3.99 ms** (sd 0.01) | PASS |
| 0, 12 ms | 12 | **12.00 ms** (sd 0.01) | MARGINAL |
| 0, 40 ms | 40 | **40.00 ms** (sd 0.01) | FAIL |
| 0, 4, 40 ms (3 phones) | 40 | **40.00 ms** (sd 0.01) | FAIL |

Two bugs that the validation caught and that would have quietly produced fiction in a venue:

1. **A click whose search window ran past the end of the file** was correlated against a truncated window
   and returned a confident-looking peak 78 ms away. One bad row can move a median. Clicks whose window
   does not fit are now dropped and counted.
2. **Sidelobes were being reported as extra phones.** A drum hit correlated against itself has secondary
   maxima a millisecond or two out, and "give me the 2 strongest separated peaks" returns one of them. Two
   *perfectly synchronised* phones therefore measured as 1–8 ms apart — a number that looks plausible,
   points the wrong way, and would have sent someone hunting a sync bug that did not exist.

   The fix came out of the validation data rather than a guess: a real second phone's peak is ≈75 % as
   strong as the first, a sidelobe is ≤46 %, so `--min-relative 0.55` separates them. The residual limitation
   is honest and printed: the rig **cannot distinguish two phones within ~1 ms from one phone**, and says
   INCONCLUSIVE rather than inventing a spread. That is good news wearing an unhelpful label — and the way
   to turn it into a measurement is the B4 trick: nudge one phone +40 ms, confirm the rig reports 40 ms, and
   you have established both that the phones were together and that the instrument is honest.

   The 0.55 threshold is empirical, from *this* click on synthetic recordings. If a real room disagrees,
   re-run `synth-recording.ts` with realistic gains and adjust — that is what it is for.

### Running it

```bash
# validate the instrument first (takes seconds, needs no hardware)
bun packages/sync-client/rig/synth-recording.ts --out /tmp/known.wav --offsets 0,12
bun packages/sync-client/rig/measure.ts --wav /tmp/known.wav --phones 2      # must report ~12 ms

# then the real thing
bun packages/sync-client/rig/measure.ts --wav recording.wav --phones 3 --json evidence/backend/rig-t0.json
bun packages/sync-client/rig/measure.ts --wav recording-5min.wav --phones 3 --from 0 --to 30
```

It exits non-zero on FAIL, so it can gate a check rather than just inform. `--json` writes every per-click
row for an evidence file. WAVs are gitignored; commit the JSON and a one-line summary.

Reading the output: a spread that is **stable** across the recording is output latency (fix it with the
nudge slider or with the tuning moment below). A spread that **grows** with time is clock or audio-clock
drift, which is what B4's resync is for — running the rig at t=0 and again at t=5 min is how you tell them
apart, and is exactly why B4's evidence file quotes both.

## `runAsReference` — built, unverifiable here

`src/calibration/reference.ts` implements the full flow from docs/04: microphone with echo cancellation,
AGC and noise suppression all off; capture through an `AudioWorkletNode`; `analyzeClicks` on the recording;
`CALIBRATION_REPORT`; microphone released. Three decisions worth knowing:

- **The microphone opens inside the tap, before the countdown.** iOS only grants `getUserMedia` from a
  gesture and the countdown is 3 s of `await`, so the function opens the mic first and *then* waits for
  `CALIBRATION_PLAN`. A plan that arrives during the permission prompt is held rather than lost.
- **The capture is timestamped from inside the audio graph.** The worklet reports the `currentTime` of its
  first processed frame, mapped to a server time through the same `CtxMapper` the scheduler uses. A
  timer-based estimate could be 100 ms out and lose a click; this only has to be good to ±5 ms because all
  it does is place a ±150 ms window.
- **The worklet is loaded from a Blob URL.** `apps/web` owns the build and this package must not require a
  bundler entry for a worklet file. `ScriptProcessorNode` (routed through a muted gain, because it only
  runs when connected to the destination) is the fallback.

The DSP underneath is the code the 13 tests cover. What is **not** verified here is everything involving a
microphone: permission flow, real worklet timestamps, whether a phone speaker at arm's length actually
clears the noise floor of a phone microphone.

## 🟡 What a human must do

In order. The first item is the whole gate; the rest are cheap once you are there.

1. **The real run.** Host phone on the Calibrate screen, 3 players, one of them nudged **+40 ms**. Expect
   that phone's residual ≈ **−40 ms** (recovered within ±5 ms) and the others near 0. The sign is worth
   checking rather than trusting: a +40 ms nudge advances the phone, so its click arrives *early*, so the
   residual is negative, so `calibratedOffsetMs = table − 40` and `compensationMs = 40 + table − 40 = table`.
   The nudge is recovered and cancelled. If the sign is inverted, calibration will double every error
   instead of removing it — which is the single most dangerous failure in this feature.
2. **"Everyone hold your phone near the host — within arm's reach."** Sound travels ~2.9 ms/m, so a phone
   2 m away measures 5.8 ms late even when perfectly synced. At ≤1 m the error is ≤2.9 ms and roughly equal
   for everyone, so most of it cancels in the median. This is why the Tier-2 budget line says ±2–3 ms and
   not ±0.5 ms.
3. **Confirm the microphone was released**: every `MediaStreamTrack.readyState === "ended"` after the report,
   and `/diag` shows `audioSession.type` back to `playback`. A live input track keeps iOS in
   play-and-record, which changes output latency for *everything afterwards* — i.e. a calibration run that
   forgets to release the mic makes the sync it just fixed worse.
4. **Run it twice.** Residuals accumulate onto the current value, so a second pass on a converged room
   should report residuals near 0. If the second pass reports the same residuals as the first, the server is
   not accumulating.
5. **Then the rig**, to confirm acoustically what calibration claims: record 30 s before and after applying
   offsets and compare the median spread.

## Known gaps

- `confidence` follows docs/04 (`clamp(1 − secondPeak/peak, 0, 1)`); the brief's alternative formula
  (`peak / (mean|xc| + 3σ)`) is computed too and reported as `prominence` in the diagnostics, so whichever
  the human prefers is in the evidence. The server's cutoff applies to `confidence`.
- `CalibrationResult.diagnostics` carries every per-click `{expected, arrival, raw, residual, peak,
  secondPeak, confidence, prominence}`, so the B8 evidence from a real run is raw peak-picking output rather
  than a screenshot.
- Nothing in the engine prevents `runAsReference` on a phone that is playing. The server keeps the reference
  out of the click order, and docs/04 says the host should not be a speaker during a run; if the demo ends
  up with a host that plays, the UI is the place that has to refuse.
