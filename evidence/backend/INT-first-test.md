# INT — engine v1 handed to the first real phone test

date: 2026-09-19 · PR: [#2](https://github.com/jlee0229/hive-music/pull/2) (`agent/backend` → `main`) · status: 🟡 **needs a human with phones**

Everything the engine can verify by itself is verified: 84 tests green at the root, and the three
evidence files behind B2, B3-lite and B5e. What is left is the half that only exists on real hardware.
This file is the handover, ordered by how much it would cost to discover late.

## How to run it

```
NEXT_PUBLIC_HIVE_ENGINE=real          # the frontend switches from createStubClient to createHiveClient
NEXT_PUBLIC_API_URL=https://<server>  # the deployed Bun server (server agent's B7)
NEXT_PUBLIC_WS_URL=wss://<server>/ws
```

One Wi-Fi network or one phone hotspot for every device, including the host. Cellular RTT asymmetry
breaks the ≤10 ms target and is not worth debugging — `docs/09-deploy.md` has the tunnel fallback if
Fly is not up yet.

Three phones is the useful minimum: two can be synchronised by luck, three cannot.

## 1 · The five checks that decide whether the engine works

| # | check | how to tell | if it fails |
|---|---|---|---|
| 1 | **iOS with the hardware silent switch ON still plays** | play a track on an iPhone with the switch flipped to silent | `navigator.audioSession.type = 'playback'` is not taking. `/diag` shows the value. Without it every iPhone in the room is silent *and reports healthy*, which is the worst failure mode we have |
| 2 | **Unison is indistinguishable from one speaker** | 3 phones, UNISON, `synthetic-60s`, phones side by side on a table | if you hear flam or a chorus effect, read `syncErrMs` on the host's Hive Map first: green rings mean the clock is fine and the problem is output latency (go to §2), amber/red means the clock is not settling |
| 3 | **Lock an iPhone mid-song, unlock it** | audio state shows `locked`, one tap returns to `ready` | the buffers should be retained — a re-download means `loadedTrackId` was cleared on interruption |
| 4 | **Background an Android tab for 30 s, return** | position recovers with no tap | the `visibilitychange` handler calls `apply(force: true)`; if it does not recover, `ctx.resume()` was refused outside a gesture and the UI should be showing "tap to resume" |
| 5 | **Orchestra, then wave** | each phone plays a different stem with the on-screen label matching what you hear; wave reads as a *sweep* across the room | if wave sounds like an echo, `spanMs` is too big for the room — drop it toward 120 ms. A short gap on entering/leaving WAVE is expected until B4 (see §3) |

## 2 · The measurement I need back: `ctx.outputLatency` per browser family

`STARTER_LATENCY_TABLE_MS` is **guesses** — 60 / 45 / 25 / 30 ms for ios-safari / android-chrome /
desktop-chrome / desktop-safari. Only the *differences between rows* matter, because a value common to
every phone shifts them all equally and is inaudible.

From `/diag` on each device, please record: browser family, phone model, `outputLatencyMs`,
`sampleRate`, and the `syncErrMs` it settles at. Those numbers replace the table at B4. Two iPhones of
different generations are worth more here than two of the same.

If the table is wrong, the symptom is unison that is *consistently* off between families (all iPhones
early, all Androids late) while every phone reports a healthy clock. The nudge slider is the live fix:
a phone that "sounds late" gets a positive nudge, and +40 ms should move it audibly.

## 3 · Known gaps, so nobody debugs a thing that is not built yet

- **No drift correction.** `status.lastCorrectionMs` is present and always 0; there is no 1 Hz drift
  check and no crossfade. A phone whose audio clock runs fast walks away from the timeline over
  minutes. If unison is clean at t=0 and ragged at t=3 min, that is this, not a bug. B4 is next.
- **A gap when entering or leaving WAVE.** WAVE's `delayMs` moves the playhead, so it reschedules
  rather than ramping. Until B4's 20 ms crossfade lands you get a ~10 ms stop-and-start. Worth
  listening for so we know how audible it actually is.
- **No Tier-2 calibration.** `calibration.runAsReference()` throws with a message naming gate B8e. The
  Calibrate screen cannot work yet; Tier 1 (table + nudge) is the whole story at INT.
- **`createStubClient` is unchanged and still works.** If the real engine misbehaves on stage,
  `NEXT_PUBLIC_HIVE_ENGINE` unset falls back to it — the UI keeps working, nothing plays.

## 4 · What to send back

A line per phone for the table in §2, plus for anything that failed: which check, what you heard, and
the `/diag` values at that moment (`ctx.state`, `clockOffsetMs`, `rttMs`, `syncErrMs`, `audio.state`,
`outputLatencyMs`, `audioSession.type`). `syncErrMs` is `rttMs/2 + |lastCorrectionMs|`, so during INT it
is purely a network number — if it is bad, the clock is the suspect; if it is good and unison is still
wrong, output latency is.
