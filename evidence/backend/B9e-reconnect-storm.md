# Reconnect storm — 12 phones, one server restart

date: 2026-09-20 · tests: 3 new (`packages/sync-client/src/__tests__/reconnect-storm.test.ts`) + 3 for the rig page
cmd: `bun test packages/sync-client/src/__tests__/reconnect-storm.test.ts` · full gate `34 · 120 · 22`, 0 fail

## Measured

```
[storm] 12 phones re-JOINed in 634 ms, playing again at 665 ms (budget 5000) ·
        13 JOINs, 0 AUDIO_READYs on the way back ·
        device-to-device spread 0.021 → 0.003 ms · live sources per phone 4
[storm] three consecutive restarts: still 4 live sources per phone
[storm] readiness re-announced to a fresh server after 1 AUDIO_READY, then quiet
```

12 players + 1 host, all playing, every socket dropped at once with close code **1012** (service restart).
Everyone is back and playing in **665 ms** against a 5 s budget, with **exactly one JOIN per client** and
**four live sources per phone**.

## Why the assertions are about sources, not about connections

A reconnect storm has three failure modes and only one of them is a disconnect:

1. a phone never comes back (backoff too long, or a reconnect racing a manual connect — that is P0-4);
2. a phone comes back **twice** and plays two copies of the track a few milliseconds apart. This is the
   one an audience actually hears — as flanging — and **every health indicator stays green** while it
   happens, because each socket believes it is the only one;
3. the phones come back to *different* positions: in sync with the server, out of sync with each other.

So the test counts sources that were started and never stopped (a double-connected phone has eight, not
four), asserts the live set shares one `when` and one `offset` (four sources split across two branches
would also total four), and compares each phone's emitted track-zero on the shared clock before and after.
Connection state is the easy half and is only checked to give a clean timing number.

Three consecutive restarts are run in a second test, because "it recovers once" and "it does not leak a
branch per restart" are different claims.

## A test bug that mattered more than the feature

My first version reported "**resumed in 0 ms**" with **zero JOINs** — and passed. It waited on
`client.connection === "open"` and on the room snapshot's `connected === true`, both of which were
*already* true before the storm, so `waitFor` returned in the microsecond before the close event was even
delivered. The test proved nothing at all, in the same way the calibration-reset mock tests did earlier
today (a predicate that was also true before the thing you are waiting for).

The fix is the general rule now written into both files: **await a transition, never a value that was ever
true before.** Here the transition is the server's own JOIN count crossing 12 — the one signal that can
only mean the round trip actually happened. Everything else then shares the storm's 5 s budget instead of
getting a fresh one each, so the reported 665 ms is the whole recovery and not the last step of it.

To make that possible the mock now keeps per-type arrival counts (`mock.received`) and exposes
`mock.simulateRestart()` — the existing `chaos.restartAfterSec` behaviour, callable on demand. Counting
arrivals is the only way a test can assert a **negative**: that nobody joined twice.

## A real bug the storm found: readiness was announced exactly once, ever

`AUDIO_READY` was sent at the end of decoding and never again. The storm above does not expose it, because
the mock's restart keeps the room — the server still remembers who is ready. **A restart that loses the
room is different**: the phones reconnect, resume playing correctly, and the new server never learns that
they already hold the stems. The host's "9 of 12 ready" stays wrong for the rest of the set, and any
readiness gate on the server never opens. Nothing is disconnected; the phone is simply silent about
something the server no longer knows.

Fixed in `applyRoom`, driven off the server's own view rather than off a socket event:

```ts
if (ctx && loadedTrackId && room.track?.id === loadedTrackId) {
  const known = room.clients[host.clientId]?.audioReadyTrackId;
  if (known !== loadedTrackId && performance.now() - lastReadyAnnounceAt >= READY_REANNOUNCE_MIN_MS) {
    lastReadyAnnounceAt = performance.now();
    send({ type: "AUDIO_READY", trackId: loadedTrackId });
  }
}
```

Self-limiting by construction: it stops the moment a snapshot reflects it, and `READY_REANNOUNCE_MIN_MS`
= one `ROOM_STATE` period (500 ms) covers the window in which our own message is still in flight. The
third test replaces the server outright — `mock.stop()`, a fresh `startMockServer` on the same port — and
asserts the new server learns the phone is ready **and then hears nothing more for 1.5 s**. Verified to
fail without the fix (the wait times out after 10 s; the new server never finds out).

## `rig/latency.html` — the pasteable line

The page now emits, under the diagnostic line, a line shaped like the table it goes into:

```
  "ios-safari": 58,  // iPhone, measured 58.3 ms @ 48000 Hz, 2026-09-20
```

and a Copy button that falls back to selecting the text when iOS refuses the clipboard. Two choices worth
stating:

- **`null`, not `0`, when the browser reports no `outputLatency`.** Null falls through to the phone's own
  `ctx.outputLatency` at runtime and then to acoustic calibration; `0` is a claim that a whole family of
  devices has no output latency. Same rule as `CALIBRATION_RESET` clearing to null — a missing measurement
  must never masquerade as a measured zero.
- **The `interactive` context supplies the number**, because that is the hint the engine uses. On
  Chromium 141 the `playback` context reports 72 ms against 32 ms interactive; a row measured on the wrong
  one is wrong by that gap.

The page also says, in the page itself, that **one phone is not a row**: collect a line per phone of that
family and take the median, and treat two same-family phones disagreeing by more than ~15 ms as evidence
that the family is the wrong key and those phones need Tier-2 calibration instead of a table edit.

`rig-latency-page.test.ts` reads the page as text and pins the couplings that can rot silently — every
family it emits is a real `BrowserFamily` and it can emit all of them; the line's shape matches the table;
`null` is used rather than `0`; the measured hint is `interactive`. It cannot check the numbers, and does
not pretend to.

## 🟡 Needs a human (phones)

1. 4+ phones playing, then restart the real server (`apps/server`). Every phone should be back inside 5 s
   with no audible artefact beyond one crossfade, and the host's ready count should be correct **after**
   the restart — that last part is the fix above, and the room-losing case is the one to test.
2. The one to listen for: after a restart, does any phone sound *thicker* than the others? That is
   double-connection flanging, and the headless test cannot rule it out on a real socket stack.
3. Airplane-mode one phone for 30 s mid-set and bring it back. Same assertions, one phone at a time.
4. Run `rig/latency.html` on every phone you have and paste the lines into
   `evidence/backend/latency-table.md` before anyone edits `STARTER_LATENCY_TABLE_MS` — the median of
   several, not the first one measured.
