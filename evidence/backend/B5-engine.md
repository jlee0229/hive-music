# B5e — modes in the engine: gains, `applyAtServerTime`, pattern automation

date: 2026-09-19T23:33:16Z
files: `packages/sync-client/src/scheduler.ts` (gains, patterns, timing), `src/audio.ts` (no-reload path)
tests: `src/__tests__/modes.test.ts` (10), plus the mode-switch test in `src/__tests__/audio.test.ts`
cmd: `bun test packages/sync-client/src/__tests__/modes.test.ts`

## The gate's check

| check | result |
|---|---|
| UNISON → ORCHESTRA changes gains only, no reload | ✅ same source objects before and after; 3 stems ramp to 0, 1 to unity |
| no second `AUDIO_READY` on a mode switch | ✅ engine-level test: exactly one `AUDIO_READY` across play + mode switch |
| a WAVE assignment produces a delayed start of `delayMs` | ✅ 5 phones at x = 0…1 with spanMs 240 → starts 0/60/120/180/240 ms apart, to 6 decimal places |

## Per test

pass  UNISON → ORCHESTRA re-ramps gains and starts no new source  [6 ms]
pass  every one of the five modes is a gain change except WAVE, which shifts the playhead  [2 ms]
pass  WAVE delays each phone by its position along the axis  [1 ms]
pass  STROBE gives each group a different phase and no delay  [0 ms]
pass  STEREO splits the stems by side without touching timing  [0 ms]
pass  a nudge smaller than the resync threshold ramps; a big one reschedules  [0 ms]
pass  identical snapshots at 2 Hz do not re-arm pattern automation  [1 ms]
pass  a non-playing host gets no assignment, so the engine schedules nothing  [0 ms]
pass  a scene boundary in the future ramps at that instant on every phone  [1 ms]
pass  a boundary already in the past ramps now rather than in the past  [1 ms]

## The design decision this gate forced

The plan says a mode switch is a gain change, never a reload. That is true for four of the five modes and
**false for WAVE**, whose `delayMs` (up to `WAVE_SPAN_MAX_MS` = 300) moves where the playhead has to be.
Ramping gains would leave the audio exactly where it was, so switching into WAVE mid-song would have been
inaudible — the effect would look broken with nothing in any log.

So the scheduler compares a *timing shift* (`delayMs − compensationMs`) between snapshots and:

- a change **≤ `RESYNC_THRESHOLD_MS`** (10 ms) is left alone, for the drift check to absorb (B4). This is
  the small-nudge case: a 5 ms nudge must not interrupt the audio.
- a change **> `RESYNC_THRESHOLD_MS`** reschedules the branch now. This is WAVE, and a big nudge.

Until B4 lands, "reschedules" means stop-with-a-10-ms-fade and start again, which is audible as a tiny
gap. B4 replaces it with the 20 ms crossfade and the two-branch hard resync; the decision logic above
does not change, only what happens after it.

Two smaller things the tests pinned down:

- ROOM_STATE arrives at 2 Hz, and `applyAssignmentGains` runs on every one of them. Re-arming pattern
  automation each time produced overlapping `setValueCurveAtTime` calls (Web Audio throws on overlap, so
  the automation was being rebuilt from exceptions twice a second). The scheduler now keys automation on
  a serialized pattern and skips identical ones; a test asserts that five identical snapshots add zero
  new curves.
- `applyAtServerTime` in the past ramps *now*, not at a negative ctx time. A phone that joins after a
  scene boundary has already passed would otherwise schedule automation into the past and silently keep
  the previous mode's gains.

## What a human still has to confirm (🟡, phones only)

1. ORCHESTRA on 3+ phones: each phone audibly plays a different stem, and the labels on screen match what
   you hear (the planner's `joinIndex % stems` is deterministic, so phone order is stable across joins).
2. WAVE across a room: the delay should be *heard* as a sweep, not as an echo. If it sounds like an echo,
   `spanMs` is too large for the room — drop it toward 120 ms.
3. STROBE at 2 groups: alternating phones, no clicks at the edges (the pattern has a 10 ms ramp).
4. The switch itself: no gap, no click, no reload spinner, on any of UNISON/ORCHESTRA/STEREO/STROBE.
   A brief gap **is** expected on entering and leaving WAVE until B4's crossfade lands — worth listening
   for so we know how bad it is.
