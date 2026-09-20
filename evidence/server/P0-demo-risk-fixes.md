# P0 demo-risk fixes

Four verified findings from an independent review of `apps/server`, each checked directly against the
code before fixing (one prior notification this session made a false claim about which branch held
certain commits, so every specific line-level claim here was re-derived from the actual file rather
than taken on trust — all four held up).

```
$ bun run --cwd apps/server test src/__tests__/p0-fixes.test.ts src/__tests__/calibration.test.ts
bun test v1.3.11 (af24e281)

 12 pass
 0 fail
 59 expect() calls
Ran 12 tests across 2 files. [11.34s]
```

## P0-2 — host demoted after the fixed-code room is re-spawned

Every `Room` mints a fresh `hostKey` (`crypto.randomUUID()` in the constructor). When the
`ROOM_FIXED_CODE` demo room is re-spawned — after `ROOM_IDLE_TTL_MS`, or a Fly restart — it gets a new
key that the host's stored one can never match, and a brand-new room has no `existing` client record to
fall back on either. `wantsHost` was false, the host joined as a plain player, and every host command
answered `NOT_HOST` forever. Fixed in `join()`: `wantsHost` also accepts `kind:"host"` when
`this.room.hostClientIds.length === 0` (nobody holds the room yet), and the `existing`-record branch of
the join now applies `wantsHost` to `kind`/`plays` instead of always keeping the old record's `kind` —
which was a second, related gap: a player record that already knew the *current* hostKey (e.g. a host
demoted by this same bug earlier) could never be promoted back, because the reconstruction path only
ever copied `existing.kind` forward.

Tests (`apps/server/src/__tests__/p0-fixes.test.ts`): create a room, host joins, destroy the room
(simulating a restart), a fresh room with a new hostKey is spawned, the host rejoins with the *stale* key
and is still `kind:"host"` and in `hostClientIds`; a second claimant with the *wrong* key is refused once
someone already holds the room (the "nobody holds it" clause doesn't reopen it); an existing player
record is promoted to host once it presents the room's real key.

## P0-4 — a stale socket's close demotes the live one

`disconnect(ws)` never checked that `ws` was the socket currently registered for that `clientId`. A
reconnect that raced the old socket's close (flaky Wi-Fi, a tab backgrounding and resuming) would let the
*old* socket's eventual `close` event delete the *new* one from `this.sockets` and mark the client
disconnected — even though the client is still live on the new connection. Fixed with one guard at the
top of `disconnect()`: `if (this.sockets.get(id) !== ws) return;` (`join()` already always makes the
newest socket the registered one, so this is exactly "is this the live socket").

Test: join with socket A, reconnect the same `clientId` with socket B, then close A — the client stays
`connected: true` (via B) with no spurious broadcast; closing B for real does disconnect it.

## P1-7 — calibration order included disconnected / not-ready phones

`startCalibration`'s `order` filter only checked `c.plays`, so a disconnected-but-retained record (within
`DISCONNECT_RETENTION_MS`) or a phone that hasn't finished decoding the track's stems got a slot in the
click schedule — dead air for that phone's turn, and a click the reference never hears. Fixed: the filter
now also requires `c.connected && c.audioReadyTrackId === this.room.track?.id`. Covered by updating the
existing calibration tests to actually `SET_TRACK` + `AUDIO_READY` before starting a round (previously
they didn't need to, since readiness wasn't checked) — all still green, confirming the filter doesn't
break the intended flow, only excludes phones that genuinely aren't ready.

## P0-6 — calibration base didn't fall back to outputLatencyMs for untabled browsers

For `browserFamily: "other"` (`STARTER_LATENCY_TABLE_MS.other` is `null`), the client compensates for its
own audio latency by subtracting `ctx.outputLatency` locally whenever it has neither a table value nor a
calibration value (docs/02-protocol.md §1). `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs ??
0) + residualMs` based the first round on `0` for such a client, so the moment a `calibratedOffsetMs`
existed, the client stopped its local subtraction — and the server had never accounted for it either. The
phone ends up late by exactly its own `outputLatencyMs` after one calibration pass (a second pass would
"fix" it, but the demo does one). Fixed the base to fall back to the client's own reported
`outputLatencyMs` (from `CLIENT_STATUS`, already tracked in `this.health`) before `0`.

Test: an "other"-family client reports `outputLatencyMs: 30` via `CLIENT_STATUS`, then a calibration round
with `residualMs: 0` — `calibratedOffsetMs` ends at `30`, not `0`, preserving the compensation the client
used to apply itself.

Root `bun run typecheck && bun run test`: green, 166 tests (29 protocol, 85 sync-client, 52 server).
