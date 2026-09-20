# Engine P0 — six confirmed bugs, each with a test that failed on main

date: 2026-09-20 · base: `origin/main` @ `61902fc` · tests: **14 new** (12 sync-client, 2 mock server)
cmd: `bun run typecheck && bun run test` → `@hive/protocol 31 pass`, `@hive/sync-client 97 pass`, `@hive/server 22 pass`, 0 fail

Every fix below is paired with a test that **fails against `origin/main`**. That verification was run
explicitly (checkout main's version of the source files, keep the new tests, run them): **10 of the 12
sync-client tests and both mock-server tests failed**; the two that passed on main are the two P1-10
cases where the zero-compensation default happens to coincide.

The through-line: none of these are crashes. Every one of them makes the engine **confidently wrong** —
it reports a good `syncErrMs` while doing the wrong thing. That is the failure mode a room of phones
actually exhibits, and it is the one a drift check cannot see when the check compares the ideal against
the ideal.

## P0-5 · a near-future start was rounded to "now"

`decideStart` computed `offsetSec = (serverNow − serverTimeAtTrackZero)/1000`, and for a start still in
the future that is **negative**. The old code clamped it into an immediate start at `ctx.currentTime`,
so a phone that received the `playing` snapshot 30 ms before track zero began playing 30 ms early —
and the drift check then read ≈0 ms, because it recomputes the *ideal* `startCtxForZero` and compares it
to the ideal, not to what was scheduled. Two phones receiving the snapshot at different leads were
silently offset from each other by the difference in their leads.

```ts
if (offsetSec < 0) return { whenCtx: startCtxForZero, offsetSec: 0, startCtxForZero, mode: "scheduled" };
```

A negative playhead means *schedule at `startCtxForZero` with `offset 0`* — which is exactly what Web
Audio's `start(when, offset)` is for. Tests sweep every lead from 1 ms to 200 ms and assert two phones
at different leads agree with each other; a fourth test pins that the late-join margins still mean what
they say.

## P0-3 · a null assignment was every stem at 0 dB

`assignment === null` means "the server has not made this device a speaker" (a host, a phone the vibe
engine dropped, a client mid-reassignment). `apply` fell through to the default gain path and played
**all four stems at unity, with no delay and no latency compensation** — the loudest and least
compensated thing the engine can do, in precisely the case where it should be silent.

```ts
if (assignment === null) {
  const wasPlaying = this.playing;
  if (wasPlaying) this.stopAll("no assignment: this device is not a speaker");
  return { action: wasPlaying ? "stopped" : "idle", decision: null, reason: "assignment is null" };
}
```

Four tests: losing the assignment mid-song stops the audio; a null assignment never starts anything;
when the assignment comes back it schedules from the transport as a late join; no pattern automation
runs while null.

One of my **own earlier tests** asserted the buggy behaviour — `modes.test.ts` "a non-playing host gets
no assignment" expected `"started"`, with a comment rationalising it. It now asserts `"idle"`, zero
starts, `playing === false`. Writing the rationalisation down is what made it findable.

## P0-4 · two `connect()` calls could leave two live sockets

`connect()` created a socket unconditionally. A UI that calls it from both a mount effect and a user tap
— or a reconnect racing a manual retry — ended up with two sockets, two `JOIN`s, two `ROOM_STATE`
streams and two NTP bursts feeding one `ClockModel`; the probe replies interleave and the min-RTT
window fills with samples from two different paths.

Now `connect()` is idempotent: `OPEN` resolves immediately, `CONNECTING` returns the in-flight promise,
and if a socket ever is replaced the old one has its handlers detached first and is closed with
`1000, "replaced"` so our own reconnect logic ignores the close instead of racing it.

## P1-9 · the first schedule could run with no clock at all

`reschedule` ran whether or not `clock.offsetMs` was set. Before the first NTP burst lands, `serverNow`
falls back to local time — an arbitrary offset, which for a wall clock a few seconds off means starting
seconds into the wrong part of the track. It now sets `waitingForClock = true` and returns, and the
existing `emit.on("status", …)` retries it the moment the clock is usable. A phone that joins a playing
room *waits for a clock* rather than guessing, which costs the burst window and buys correctness.

## P1-10 · scene-boundary ramps landed where the audio does not

`applyAssignmentGains` ramped at the bare clock mapping of `applyAtServerTime`, while the audio it gates
is scheduled with `delayMs`, `compensationMs` and possibly `outputLatency` folded in. On a phone with a
25 ms table entry and a WAVE delay of 120 ms the ramp fired ~145 ms before the audio it was supposed to
gate. Extracted `ctxTimeForServerTime(serverTime, a, useOutputLatency)` — the one function the scheduler
already uses for audio — and the ramp now goes through it. Two tests, one for compensation and one for
`delayMs`.

## P0-6 · calibration offsets accumulated from the wrong base (mock server)

`CALIBRATION_REPORT` carries a **residual**: how late this phone is relative to the room's median, which
is a correction to whatever compensation it is already applying. The mock added it to
`calibratedOffsetMs ?? 0`, so the first calibration of a phone already using a 25 ms table entry threw
that 25 ms away and replaced it with a ±3 ms residual — a 22 ms regression from *improving* the
measurement.

```ts
const base = c.calibratedOffsetMs ?? c.tableLatencyMs ?? health.get(m.clientId)?.outputLatencyMs ?? 0;
c.calibratedOffsetMs = base + m.residualMs;
```

The fallback chain is the same precedence the scheduler uses, so calibrating cannot make a phone worse
than not calibrating it. Two mock tests. `docs/04-calibration.md` now states the base explicitly,
including `lastReportedOutputLatencyMs`, so the real server implements the same rule.

## 🟡 Needs a human (phones)

1. **P0-5** is the one to look for on real hardware: start playback with 12 phones joined, then join a
   13th *just before* the next scene boundary. Before this fix the late joiner was early by its own
   receive lead; it should now be inaudible against the others.
2. **P0-3**: make the host a non-playing host. It must be silent. Before, it played all four stems at
   full with no compensation — the single most audible bug in this list.
3. **P0-4**: background the tab and return, twice quickly, then check `/diag` shows one socket and the
   clock's sample count did not jump.
4. **P0-6**: read a phone's `calibratedOffsetMs` before and after a tuning moment. After should be
   *near* its table entry, not near zero.
