# CALIBRATION_RESET — the undo a tuning moment did not have

date: 2026-09-20 · `PROTOCOL_VERSION` 2 → **3** · tests: 8 new (3 mock server, 4 engine, 1 client e2e)
cmd: `bun run typecheck && bun run test` → `@hive/protocol 34 pass`, `@hive/sync-client 102 pass`, `@hive/server 22 pass`, 0 fail

## Why this is a message and not a button that re-runs calibration

`CALIBRATION_REPORT` carries a **residual**: how late a phone is relative to the room's median, which is
a correction to the compensation it was *already* applying. That is the P0-6 accumulation rule, and it is
what makes "just calibrate again" the wrong fix for a bad run:

```
run 1:  base 60 (table)            + residual +40 (a sidelobe)  →  100   ← 40 ms wrong
run 2:  base 100 (the mistake)     + residual   0 (now "in sync" with its own error) →  100
```

The second run measures the room *as compensated*, so a converged room reports residuals near zero — a
wrong offset is a fixed point. Nothing in the protocol could get back out of it. `CALIBRATION_RESET`
clears the base; it is the difference between "the host fixes a bad tuning moment" and "the room is stuck
until everyone rejoins".

## What landed

| piece | where |
|---|---|
| `{ type: "CALIBRATION_RESET", clientId?: string }`, host-only | `packages/protocol/src/messages.ts` |
| `PROTOCOL_VERSION` 2 → 3 | `constants.ts` |
| doc row (the schema test diffs the table against the zod union) + rules section | `docs/02-protocol.md` §4, `docs/04-calibration.md` |
| mock server: clear, refuse mid-run, replan, flush | `mock-server.ts` |
| `host.resetCalibration(clientId?)` on the frozen public API | `sync-client/src/index.ts` (+ `client.ts`, `stub.ts`) |

Additive, so the frozen contract holds. The bump follows the R-6 rule: bump when a peer that does not
understand the change is genuinely incompatible, and a new *message type* qualifies — a v2 server answers
`BAD_MESSAGE` and the host's Reset button silently does nothing.

## Three decisions worth disagreeing with

**Cleared to `null`, never `0`.** Null falls back through `tableLatencyMs` and then the phone's own
`ctx.outputLatency`; zero is a positive claim that the phone has no output latency, which is never true.
The test asserts the cleared phone's `compensationMs` goes back to **60** (its ios-safari table row), not
to 0 — resetting a measurement must not be worse than never having measured.

**Refused while a run is in flight, `done` included.** This is the non-obvious one. The residuals in a
report were measured against the compensation the phones applied *at click time*; if the base is cleared
between the clicks and the report, those residuals get added to a different base — writing in exactly the
error the reset was meant to remove. So `calibration.state !== "idle"` answers `ERROR`
`CALIBRATION_BUSY` (the `code` field is a free-form string, so no schema change), and the host cancels
first. The alternative — silently cancelling on the host's behalf — overloads one button with two
destructive operations.

**The engine gets no new code.** A reset changes `assignment.compensationMs`, and a compensation change
over `RESYNC_THRESHOLD_MS` (10 ms) already reschedules while a smaller one is slewed by the drift check.
That is the B4 rule. But "no new code" is not the same as "no test": a reset the phone does not act on is
a control that lies — the host watches the number vanish from the Hive Map and hears nothing change — so
`calibration-reset.test.ts` pins the behaviour at the reset boundary, in both directions, including the
sign. A realistic reset is 40–100 ms, 4–10× the threshold, so it is always the reschedule branch.

## A test bug the tests found, which is the reason to run them

My first pass at the mock tests **passed while the server did nothing**. `Fake.next()` searches the
inbox before waiting, and the predicate I used — `calibratedOffsetMs === null` — was *also* true of every
snapshot from before the run. So `await next(…)` resolved off a stale message, immediately, and the
assertions that followed described a room that had never been calibrated. It only surfaced because I
also asserted on the live `mock.room`, which still read `32` and `16`.

Fixed with `Fake.forget()`, called immediately before the message whose effect is awaited, and the same
weakness in the existing CALIBRATION_CANCEL test (`state === "idle"`, true before the run too) is
hardened the same way. This is the second time in this file a predicate matched history rather than the
future; the lesson is that in a shared-room test, **await a transition, never a value that was ever
true before**.

## 🟡 Needs a human (phones)

1. Calibrate a room, note a player's `calibratedOffsetMs` on the Hive Map, then reset that one player.
   The number must go to *the table row for its browser* (≈60 ms on iOS Safari), **not** to 0 or blank,
   and the phone must audibly step back into line with the others.
2. Reset the whole room while playing. Every phone shifts by its own amount; nothing drops out or glitches
   (each shift is a crossfaded resync, `RESYNC_CROSSFADE_MS` = 20 ms).
3. Press Reset *during* a tuning moment. It must refuse (the UI should have the button disabled; the
   server's `CALIBRATION_BUSY` is the backstop, and seeing it means the UI is missing the guard).
4. The one that would be a real bug: reset, then run a tuning moment again, and check the resulting
   offsets are near the table row plus a small residual — not near the residual alone.
