# B4 — drift correction, the Tier-1 table, and nudge end to end

date: 2026-09-19 · files: `packages/sync-client/src/scheduler.ts`, `packages/sync-client/rig/latency.html`
tests: `src/__tests__/drift.test.ts` (9) · cmd: `bun test packages/sync-client/src/__tests__/drift.test.ts`

## Measured

```
[B4] +50 ppm audio clock over 5 min: 1 resyncs, worst |error| 10.00 ms, mean |error| 4.19 ms
     (threshold 10 ms — a hard-resync design cannot beat its own threshold)
[B4] the same 5 minutes with the drift check disabled: 15.00 ms of error
[B4] +50 ppm system-clock drift over 5 min: clock estimate stayed within 1.450 ms
```

| check | asked for | measured | verdict |
|---|---|---|---|
| +50 ppm audio clock over 5 min | "within 5 ms" | **mean 4.19 ms, worst 10.00 ms**, 1 resync | ⚠️ see below — met in the mean, not in the worst case, and that is structural |
| +50 ppm system clock over 5 min | within 5 ms (docs/03) | **1.450 ms** | ✅ |
| nudge +40 ms shifts the scheduled start | 40 ms exactly | **40 ms to 6 decimal places** | ✅ |
| hard resync crossfades | 20 ms, old out / new in | ✅ both ramps end at the same instant, `RESYNC_CROSSFADE_MS` after the new branch starts | ✅ |

## The "5 ms" in the brief is not reachable with a resync-at-10-ms design, and that is worth knowing

A hard-resync loop cannot hold the error below its own trigger threshold. With
`RESYNC_THRESHOLD_MS = 10`, a phone whose audio clock runs 50 ppm fast accumulates error at 0.05 ms/s,
crosses 10 ms after ~200 s, gets corrected to ~0, and climbs again — a sawtooth with a 10 ms peak and a
~5 ms mean. That is exactly what the test measures (mean 4.19 ms, worst 10.00 ms, 1 resync in 5 minutes).

So the honest reading is: **this meets the project's actual target and not the brief's phrasing.** The
target everywhere else in the plan is ≤10 ms device-to-device (`SYNC_TARGET_MS`), with 30 ms as the
floor, and the sawtooth peak *is* 10 ms. Without the drift check the same five minutes ends at 15 ms and
keeps going — at the end of a three-minute demo track a phone would be a comfortable 9 ms out and
climbing, so the check earns its place regardless.

Three ways to actually reach 5 ms, in the order I would try them:

1. **`playbackRate` slewing (B9e, already on the stretch list).** Correct continuously at ±0.5 % instead
   of discretely: 50 ppm is 0.005 %, so the correction is 100× inside what is audible, and the error
   never accumulates past a fraction of a millisecond. This is the right fix. It also removes the
   crossfade artifact entirely. **Recommendation: promote B9e above the rest of the cut list if the phone
   test shows drift is a visible term.**
2. **Halve `RESYNC_THRESHOLD_MS` to 5.** One line, halves the bound, doubles the crossfades (one per
   ~100 s per phone at 50 ppm). I did not do it: the constant is quoted in four docs and is also the
   number the health colours and the plan's target are written against, so changing it is a contract
   decision, not a tuning one. Easy for the human to take.
3. Nothing. 10 ms peak with a ~5 ms mean is inside the stated target.

One thing I considered and rejected: correcting to the *opposite* edge (resync at +10 ms down to −10 ms)
to double the interval between resyncs. It halves the absolute bound per phone but leaves the
**pairwise** bound identical — two phones drifting oppositely still end up 10 ms apart either way — while
deliberately introducing error in the direction we are least sure about. Not worth it.

## Why the drift check is one subtraction

```ts
errorMs = (ctxTimeForTrackPosition(zero, 0, assignment, useOutputLatency) - branch.startCtxForZero) * 1000
```

The ideal ctx time for track position 0 *computed now*, minus the one we actually scheduled with.
Positive means this phone is ahead.

It reuses the scheduler's own `ctxTimeForTrackPosition`, deliberately: a drift check with its own
derivation of the same formula is precisely how a sign error survives in one code path and not the other,
and a sign error here makes drift *worse* every second while looking like it is working. Reusing the
formula also means it catches every error source at once with no extra code — the clock offset moving
(the mapping moves), a nudge or a mode change (compensation and delay are inputs), and the audio clock
drifting (`ctx.currentTime` advances faster than real time, so the ideal start slides later).

The crossfade needed its own gain node per branch. During WAVE or STROBE the pattern gain is under
`setValueCurveAtTime` automation, and fading on that same param would either fight the curve or be
erased by it. Graph is now: `source → stemGain → patternGain → fadeGain → master → destination`.

## A resumed tab drift-checks instead of restarting

`visibilitychange` → visible and `statechange` → running call `apply(force: true)`. That used to force a
full restart. It now runs the drift check instead, so a tab that was hidden for two seconds with no drift
is not interrupted at all, and one that was suspended long enough to matter gets a 20 ms crossfade rather
than a hole. This is the most common recovery path in the whole system — every phone that gets a
notification takes it — so it should be the quietest.

## Tier-1 table: 🟡 measured as far as this environment can reach, which is not far

`STARTER_LATENCY_TABLE_MS` is **unchanged** (`ios-safari` 60, `android-chrome` 45, `desktop-chrome` 25,
`desktop-safari` 30, `other` null). Here is what I could and could not do.

**Measured, in the Chromium that ships in this container** (141.0.0.0, Linux, `--no-sandbox`):

| latencyHint | baseLatency | outputLatency | sampleRate |
|---|---|---|---|
| `interactive` | 10.0 ms | **32.0 ms** | 44100 |
| `balanced` | 10.0 ms | 32.0 ms | 44100 |
| `playback` | 23.2 ms | **72.0 ms** | 44100 |

Two conclusions, of unequal value:

- **Solid and device-independent: `latencyHint: "interactive"` is load-bearing.** `"playback"` more than
  doubles reported output latency (32 → 72 ms). That is a Chromium buffering policy, not a property of
  this container's hardware, so it will hold on real devices. The engine already passes `"interactive"`;
  this is the number that justifies it, and it is worth re-checking on one real phone.
- **Not solid: the 32 ms itself.** This container has no sound card, so Chromium is reporting its
  estimate for a dummy output device. Replacing a guess of 25 with a differently-shaped guess of 32
  would not be an improvement, so I left the table alone.

**Delivered instead of a number: `packages/sync-client/rig/latency.html`.** A self-contained page — no
build, no dependencies — that anyone opens on a phone, taps once, and gets a paste-ready line with
`outputLatency` at both hints, `baseLatency`, sample rate, `audioSession` support and wake-lock status.
That is the actual way to fill this table, because the rows that matter are the two I cannot reach
(`ios-safari`, `android-chrome`) and they are only reachable from a phone. It runs the same unlock
sequence the engine does, so the numbers come from a context in the same state.

### What the human should do with it, and how to read the result

1. Serve it over HTTPS or localhost (`audioSession` and wake lock are gated on a secure context) and open
   it on every phone that will be in the demo. One tap each.
2. Paste the lines into this file. **Only the differences between families matter** — a constant common to
   every phone shifts them all equally and nobody hears it. So if iOS reports 60 and Android 45, what
   matters is the 15 ms gap, not either number.
3. If `outputLatency` comes back 0 or missing (expected on WebKit — the engine's code comments and
   docs/03 both flag it as unreliable), that family's row cannot be measured this way at all. Its value
   has to come from B8e's acoustic calibration or from a human turning the nudge slider until unison
   sounds right, then reading the number off.

A faster path to the same table, once B8e lands: run the tuning moment with one phone per family in the
room. The residuals *are* the inter-family differences, measured acoustically, which is strictly better
than anything `outputLatency` can tell us.

## Nudge, end to end

Covered in three places rather than one, because the sign convention is the easiest thing in this project
to get backwards:

- `drift.test.ts` — a +40 ms nudge registers as −40 ms of drift (the device is late, so relative to the
  schedule in force it is behind where it ought to be) and −40 ms registers as +40 ms.
- `modes.test.ts` — a nudge above the threshold reschedules and moves the start 40 ms earlier, exactly.
- `client.test.ts` — `nudgeSelf(-40)` goes to the server and comes back inside the assignment as
  `compensationMs: -40`, so the engine never adds the table itself.

Sign convention, for the phone test: **"sounds late" → positive nudge → the phone starts earlier.**
