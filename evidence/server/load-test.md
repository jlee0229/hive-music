# Load test — 30 clients, 3 minutes

Phase-2 item 3. `apps/server/scripts/load-test.ts` spawns a real server, joins 30 fake WebSocket clients (1
host + 29 players) into one room, runs each on JOIN once / `NTP_REQUEST` at 1Hz / `CLIENT_STATUS` every 2s,
has the host do `SET_POSITION` at 10Hz for the first 20s and `SET_MODE` every 10s for the whole run, and
reports NTP processing latency, `ROOM_STATE` broadcast rate, the largest message size, and server RSS.
Run: `bun apps/server/scripts/load-test.ts --clients 30 --duration 180`. Final numbers: `evidence/server/load-test.txt`.

## What it found, and the fix

The **first run found a real bug**: `ROOM_STATE` broadcasts exceeded the `ROOM_STATE_MAX_HZ = 2` cap during
a burst (5 clients joining within ~100ms produced 25 broadcasts in 10s — 2.5Hz average, 6 messages in one
1-second window). Root cause, matching exactly what the engine's independent review of their earlier
`apps/server` draft had already flagged (`docs/PROTOCOL-REQUESTS.md` R-1 point 1): `flush()` was a plain
`setInterval(flush, 500)` poll, but `join()` also called `flush()` **directly and unconditionally** ("a
joiner gets its snapshot immediately") — so N joins in quick succession produced N immediate broadcasts,
with nothing capping the burst.

**Fix** (`apps/server/src/rooms.ts`): `flush()` is now real leading-edge coalescing — publish immediately if
`ROOM_STATE_MAX_HZ`'s window has elapsed since the last publish, otherwise arm one trailing timer for
exactly `lastPublishAt + 1000/ROOM_STATE_MAX_HZ` (self-correcting to a fixed grid no matter when within the
window a change arrives). Every state-mutating path (`replan()`, `TRANSPORT`, `AUDIO_READY`,
`CALIBRATION_START`, the calibration state-transition timers, `disconnect()`) now calls `flush()` directly
instead of relying on a periodic poll, so a burst of N changes always produces at most one broadcast per
window — the *first* possible one, not delayed by a full poll interval either. A 20ms guard band on the
trailing timer (`Room.TRAILING_GUARD_MS`) absorbs ordinary `setTimeout` scheduling slop that otherwise
shaved a few ms off the nominal 500ms gap under sustained load (measured directly with this script before
adding the guard band: ~486ms; after: ~499–501ms across repeated runs).

Before/after on the same synthetic burst (5 clients, 10s):

| | before | after |
|---|---|---|
| average broadcast rate | 2.5 Hz | 2.1 Hz |
| worst 1-second window | 6 messages | 3 messages (2 once the guard band was added) |

At the actual target scale (30 clients, 180s) the fix holds with margin: 0.311Hz average (SET_POSITION only
runs the first 20s; most of the run is idle), smallest gap between broadcasts 499.7ms.

## Other results

- **NTP processing latency** (`t2 - t1`, stamped as the first and last statements of the handler): p50 =
  0.000ms, p99 = 0.001ms, max = 0.032ms across 5370 samples — comfortably under the 1ms target. `NTP_REQUEST`
  is answered synchronously with no room lookup or coalescing in the path, so this was expected to be fast;
  the test confirms it stays fast under 30 concurrent clients.
- **Largest message**: 17878 bytes (a `ROOM_STATE` snapshot with 30 clients, well under the 64KB target).
- **Server RSS**: 74.3MB → 76.4MB over 3 minutes with 30 clients continuously connected (+2.8%) — flat, no
  sign of an unbounded leak. `evidence/server/load-test.txt` has the exact numbers from the recorded run.

Root `bun run typecheck && bun run test`: green, 145 tests (unaffected by the coalescing fix — verified after
every change to `flush()`).
