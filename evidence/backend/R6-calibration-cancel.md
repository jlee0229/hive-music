# CALIBRATION_CANCEL — answering the frontend's R-4

date: 2026-09-20 · `PROTOCOL_VERSION` 1 → **2** · tests: 9 new (3 mock server, 6 engine)
cmd: `bun test packages/protocol/src/__tests__/mock-server.test.ts packages/sync-client/src/__tests__/calibration-cancel.test.ts`

## The shape of the problem

The frontend asked for a message that stops a tuning moment. The obvious implementation — server sets
`calibration = idle` — is only **half** of it, and shipping only that half would have left the reported
bug exactly where it was.

The reason is in the flow: `startCalibration` hands out **every** click up front as a `SCHEDULED_ACTION`
with a future `serverTimeToExecute`, because a phone needs lead time to render a click at an exact ctx
time. By the time anyone presses Cancel, all N clicks are already on the wire and scheduled inside each
phone's AudioContext. **The server cannot un-send them.** So cancelling is two things:

1. **server** → `room.calibration = IDLE_CALIBRATION`, stop the countdown timers, refuse a late report;
2. **every client** → on seeing the room go `running → idle`, stop its *own* pending click.

Without (2), a cancelled tuning moment still fires clicks across the room, which is precisely what R-4
described. No new message was needed for the retraction — the existing `ROOM_STATE` broadcast carries it.

## What landed

| piece | where |
|---|---|
| `CALIBRATION_CANCEL` client→server message (host-only, no fields) | `packages/protocol/src/messages.ts` |
| `PROTOCOL_VERSION` 1 → 2 | `constants.ts` |
| doc row + version note (the schema test diffs the table against the zod union) | `docs/02-protocol.md` §4 |
| mock server: idle, timers cleared, late report refused | `mock-server.ts` |
| `host.cancelCalibration()` on the frozen public API | `sync-client/src/index.ts` |
| engine: pending clicks silenced on `running → idle` | `audio.ts` |
| engine: in-flight `runAsReference()` rejects with `CalibrationCancelledError`, mic released | `calibration/reference.ts` |

**This one does bump the version**, unlike `dropSec` in R-2. The distinction I argued there: bump when a
peer that does not understand the change is genuinely incompatible. A new *message type* qualifies — a v1
server receiving `CALIBRATION_CANCEL` answers `BAD_MESSAGE` and the host's Cancel button silently does
nothing. An optional response field did not.

## Design decisions worth disagreeing with

**A cancel rejects rather than resolves.** `runAsReference()` throws `CalibrationCancelledError` (its own
class, so `err.name` distinguishes it) instead of resolving with an empty result. A cancelled run produced
no measurements, and returning `{measurements: []}` invites a caller to treat "nobody was heard" and "you
pressed Cancel" the same way. `onProgress` is *not* given a `failed` phase for a cancel — the phase union
is on the frozen API surface and widening it could break an exhaustive `switch` in the UI, and calling a
deliberate cancel a failure is wrong anyway.

**A click that is already sounding is left to finish.** Only clicks whose scheduled ctx time is still in
the future are stopped. Cutting a 22 ms click that is already leaving the speaker converts it into a
different click — an actual glitch — for no benefit.

**The transition is watched, not the value.** The engine cancels on `running → idle`, not on `idle`. A
phone that joins an already-idle room, or one that sees the natural `done → idle` settling, must not try
to cancel something it never scheduled. A test covers both.

## A bug the tests found, which is the reason to write them

The first version set the cancel flag and trusted `runAsReference` to notice. It does — **at its next
await point**, and when the host cancels during the countdown that point is `awaitPlan`, which blocks for
`PLAN_TIMEOUT_MS` = **10 seconds**. So a cancel would have held the microphone open for ten seconds after
the user asked for it to stop. On iOS that keeps the audio session in play-and-record, which changes
output latency for *every phone afterwards* — a cancelled calibration would have quietly degraded the
sync of the show that followed.

Fixed by giving the engine a `planRejecter` that rejects the pending `awaitPlan` immediately. The test
asserts the run settles well inside a 5 s budget and every `MediaStreamTrack.readyState === "ended"`; it
would time out against the old code rather than merely reporting a worse number.

## Still the server agent's to do (`apps/server` is not my tree)

The mock is the reference implementation; the real server needs the same three things, and R-6 in
`docs/PROTOCOL-REQUESTS.md` spells them out:

1. handle `CALIBRATION_CANCEL` (host-only) → `IDLE_CALIBRATION` + clear the countdown/failure timers;
2. **refuse `CALIBRATION_REPORT` when `calibration.state === "idle"`** — this is the guard that stops a
   cancelled run writing `calibratedOffsetMs` from a report that was already in flight;
3. publish the idle state immediately rather than on the 2 Hz coalescer: every millisecond of delay is
   another click the room hears after someone pressed Cancel.

## 🟡 Needs a human (phones)

1. Start a tuning moment with 3 players, press Cancel during the 3 s countdown → **no clicks should be
   heard at all**, and the Calibrate screen should return to idle.
2. Press Cancel *during* the clicks → the click currently sounding may finish; no later one should fire.
3. Check `calibratedOffsetMs` is unchanged on every player afterwards (Hive Map → player sheet).
4. On the host phone, confirm the mic released: `/diag` shows `audioSession.type` back to `playback`.
   This is the one that matters most, because a leaked mic makes the *next* thing you measure wrong.
