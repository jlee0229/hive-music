# B9e — playbackRate slewing: the gate, the numbers, and what the numbers do not cover

date: 2026-09-20 · tests: 9 new (`packages/sync-client/src/__tests__/slew.test.ts`) · 1 existing test updated
cmd: `bun test packages/sync-client/src/__tests__/slew.test.ts` · full gate: `@hive/protocol 34 · @hive/sync-client 114 · @hive/server 22`, 0 fail

## The gate

The condition for shipping this ON by default was: **5 minutes at +50 ppm, mean |error| < 3 ms, worst
< 5 ms, zero hard resyncs.** Measured:

| run | mean \|error\| | worst | resyncs |
|---|---|---|---|
| **+50 ppm, slewing ON** | **0.403 ms** | **0.550 ms** | **0** |
| +50 ppm, slewing OFF (v1 behaviour) | 4.192 ms | 10.000 ms | 1 |
| −50 ppm, slewing ON | 0.396 ms | — | 0 |
| +50 ppm with ±1 ms clock jitter, ON | 0.549 ms | 1.558 ms | 0 |
| +900 ppm (past the cap), ON | — | 10.140 ms | 12 (vs 25 OFF) |

Every threshold is met with a 5–10× margin, so `PLAYBACK_RATE_SLEW_DEFAULT = true`. The worst case is
**0.55 ms, one ninth of the 5 ms bar** — and the reason it is that small rather than "just under" is the
deadband: the error limit-cycles between 0 and `PLAYBACK_RATE_DEADBAND_MS` + one tick of drift, never
reaching a level worth correcting hard.

## Why the error existed at all

A phone's `AudioContext.currentTime` is its **audio hardware's** clock, not its system clock. A crystal
50 ppm fast emits 1.00005 s of content per real second: 3 ms/minute, 15 ms over a five-minute set. The
clock model cannot help — it synchronises the *system* clock to the server, and this drift is between the
audio clock and the system clock. So v1's only recourse was the hard resync, which means the error
**necessarily** sawtooths up to `RESYNC_THRESHOLD_MS` before anything happens: a hard-resync design cannot
beat its own threshold, and the room buys a 20 ms crossfade every ~3.5 minutes forever.

## The control law, and the two numbers that decide whether it works

```
ppm  = 0                                                              if |errorMs| < PLAYBACK_RATE_DEADBAND_MS
     = clamp(−errorMs · 1000 / PLAYBACK_RATE_TAU_SEC, ±PLAYBACK_RATE_MAX_PPM)
rate = 1 + ppm/1e6      source.playbackRate.setValueAtTime(rate, ctx.currentTime)
```

**τ = 2 s ≥ 2 × `DRIFT_CHECK_INTERVAL_MS`.** With a 1 Hz measurement, each tick removes at most half the
measured error: `e_{n+1} = ½e_n − ½w_n` for noise `w`. That is an AR(1) with standard deviation ≈0.58× the
noise — bounded. τ = 1 s would cancel the whole measured error each tick, which with noise is a
random walk driven by the noise; τ = 0.5 s would overshoot and oscillate. This is the one place where
getting the gain wrong looks fine in a noiseless simulation and misbehaves on real phones, which is why
the jitter run above exists.

**The deadband earns its keep more than the gain does.** `driftErrorMs` inherits the clock model's noise,
and the applied clock offset is itself slewing at up to 2 ms/s. Without a deadband the rate would never be
1 and would be permanently reacting to nothing. 0.5 ms is well under the 10 ms budget and above the noise
floor of a room on one AP.

**500 ppm** is 0.5 ms of correction per second and **0.87 cents** of pitch shift — under the ~5 cent
just-noticeable difference for a complex tone, and a constant offset rather than a wobble, which is the
audible distinction that matters. It bounds correction authority at 10× a typical crystal error.

## The part that is easy to get wrong: the engine must do its own accounting

Nothing in Web Audio reports how much content a source has played. `startCtxForZero` is where track zero
left the speaker *if the rate were 1*; once it is not, the effective value is `startCtxForZero − slewSec`,
where `slewSec` integrates `(rate − 1)` over ctx time. Omit that and the drift check reads its own
correction as remaining error and never stops correcting — the **same shape of bug as P0-5**, where the
check compared the ideal against the ideal and reported zero while the phone was 30 ms early.

So the simulation models the truth **independently**: it integrates content consumption from the value the
engine actually wrote to `source.playbackRate` (the observable), not from `slewSec`, and asserts the two
agree. Measured disagreement over 300 ticks: **0.000000 ms**. A simulation built on the engine's own
integral would have reproduced an accounting bug rather than catching it, and would have passed.

This is also why the first version of the simulation *failed* with a truth gap of exactly 20.000 ms: my
truth model double-counted `LATE_START_MARGIN_SEC`, adding a full second of content from wall time 0 when
the source was armed 20 ms in. The engine was right and the model was wrong — but a 20 ms disagreement is
exactly what a real accounting bug would look like, which is the point of asserting on it.

## What slewing does *not* do

- **It does not replace the crossfade.** A clock step, a resumed tab, a seek, or a drift past the ppm cap
  still needs one. At +900 ppm slewing halves the resyncs (12 vs 25) and no more; the test asserts
  `resyncs > 0` there so nobody reads this as magic.
- **A resync resets the trim to 1.** The step *is* the correction; carrying a trim across it corrects
  twice.
- **It corrects the playhead, not the pitch relationship between phones.** Two phones slewing in opposite
  directions differ in pitch by up to 1.7 cents. Inaudible as pitch, but it means two phones are never
  *exactly* rate-locked — if a future feature needs phase-locked stems across devices (a genuine
  beamforming trick, say), this is the constraint it runs into.
- **`syncErrMs` is unchanged and still honest**: it is `rtt/2 + |lastCorrectionMs|`, and slewing does not
  touch `lastCorrectionMs`, so a slewing phone reports the same bound it always did rather than claiming
  credit for a correction that is still converging.

## 🟡 Needs a human (phones)

1. Two phones, 5+ minutes of continuous playback, rig-measure at t=0 and t=5 min. The prediction is that
   **neither phone crossfades at all** (`/diag` → `resyncCount` stays 0) where before at least one would.
2. Watch `/diag` → `slewPpm` on each phone for a minute. Expect it to sit near 0 with excursions to a few
   hundred ppm of one sign. A phone **parked at ±500** means the cap is saturated: its clock is worse than
   500 ppm, or something else (a wrong calibration offset) is being mistaken for drift.
3. Listen for pitch. 0.87 cents should be inaudible even on a sustained vocal stem; if anything is
   audible, the trim is being applied far more often than the deadband should allow — check `slewPpm`
   before believing the ear.
4. Flip it off (`/diag`, `slewEnabled`) mid-set and confirm the crossfades come back. A fallback nobody
   has exercised is not a fallback.
