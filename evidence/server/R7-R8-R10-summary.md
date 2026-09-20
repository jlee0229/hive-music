# R-7 CALIBRATION_RESET, R-8 fixture + AUDIO_READY, R-10 stale-socket guard

```
$ bun run --cwd apps/server test src/__tests__/calibration.test.ts
bun test v1.3.11 (af24e281)

 11 pass
 0 fail
 56 expect() calls
Ran 11 tests across 1 file. [11.34s]
```

## R-7 — `CALIBRATION_RESET` (protocol v3)

`resetCalibration(ws, clientId?)` in `apps/server/src/rooms.ts`, ported from the mock:

- Refused with `ERROR CALIBRATION_BUSY` unless `calibration.state === "idle"` — a residual is measured
  against whatever compensation the phone was applying *at click time*, so clearing the base between the
  click and the report would add the residual to a different base and bake in the very error the reset
  was meant to undo. Cancel first, then reset.
- An unknown `clientId` gets `ERROR NO_CLIENT` naming it.
- Otherwise clears `calibratedOffsetMs` to `null` — never `0` — for one client or, with no `clientId`,
  every client in the room, then `replan()` (flushes directly, not through the coalescer, since
  `compensationMs` is derived from what was just cleared and the host is watching the numbers change).
- Host-only.

Three tests in `apps/server/src/__tests__/calibration.test.ts`'s `CALIBRATION_RESET` suite, matching the
mock's own scenarios: reset one client (busy-refused mid-run → cancel → succeeds, compensation falls back
to the `ios-safari` table row); reset the whole room and confirm a second reset is idempotent (no error);
host-only and the `NO_CLIENT` message names the offending id.

## R-8 §1 — `synthetic-30s-lite` fixture

`fixtures/gen-synthetic.ts` refactored from one hardcoded track into a parameterized `generateTrack(cfg)`
called once per entry in a `TRACKS` array. The seeded LCG noise generator is reseeded to the same constant
inside each call, so generation order can never affect either track's bytes — verified by regenerating and
diffing `synthetic-60s`'s energy curve against the exact 60-value array quoted throughout this session's
earlier evidence and PROTOCOL-REQUESTS entries (identical).

New track: `synthetic-30s-lite`, 22050 Hz, 30.0s, 120 BPM, drop at 15s, four stems. `durationSec` in
`meta.json` comes from the config (`DUR_SEC`), never derived from the sample count, per R-8's explicit
ask. `GET /tracks` lists it automatically — `apps/server/src/library.ts` globs every
`fixtures/tracks/*/meta.json` — confirmed with a real server boot + curl, no server code change needed.

Footprint: four 60s/44.1kHz stems ≈ 21MB → four 30s/22.05kHz stems ≈ 5.1MB (≈4.1x smaller).

## R-8 §2 — repeated `AUDIO_READY` is a no-op, not an error

Already true from this session's earlier `ROOM_STATE`-coalescing fix: the handler only sets
`audioReadyTrackId` and calls `flush()` directly — never `ERROR` — so a repeat costs nothing beyond an
identical-value re-set, and (unlike before that fix) is reflected in the very next `ROOM_STATE` rather than
waiting up to 500ms on a poll, which is what the engine's re-announce-on-missing-in-snapshot guard needs to
converge in one round instead of looping.

## R-10 — stale-socket close guard

Already covered by this session's earlier P0-4 fix: `disconnect(ws)`'s first line is
`if (this.sockets.get(id) !== ws) return;` — the identical guard the mock's `close()` now has.
`apps/server/src/__tests__/p0-fixes.test.ts`'s existing P0-4 test already pins both directions the mock's
two new tests pin (the orphan's close does not demote the live connection; the last socket to close still
marks the client offline), plus a third check the mock's tests don't: a stray message from the dead socket
is silently ignored rather than erroring against the live client's host status. No new code.

Root `bun run typecheck && bun run test`: green, 215 tests (37 protocol, 121 sync-client, 57 server).
