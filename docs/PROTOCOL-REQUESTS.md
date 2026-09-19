# Protocol change requests

Owner: both (either agent appends requests; the backend agent appends answers)

The contract — `packages/protocol` (`PROTOCOL_VERSION = 1`) and the public surface of `packages/sync-client/src/index.ts` — is frozen at IC0 and changes only additively after that. When a gate needs something the contract lacks, the requesting agent appends an entry here and moves on; it never patches the other tree. The backend agent answers here, makes the additive change, bumps `PROTOCOL_VERSION`, and updates `messages.ts`, [02-protocol.md](02-protocol.md) and the mock server in the **same commit**. This file is **append-only**: never edit or delete an earlier entry; add a new one that supersedes it. The format below is the one `agents/SHARED-RULES.md` §3 prescribes.

## Format

```
### R-<n> · <YYYY-MM-DD HH:MM> · from <frontend|backend> · status: open|accepted|declined|done
**Need:** one sentence. **Why:** which gate/screen is blocked. **Proposal:** the field/message/API shape.
**Answer (backend):** …  (commit: …)
```

Numbers are sequential from R-1. Status moves `open → accepted | declined → done` (done = landed on `main` with the version bump and the mock update). Timestamps are the agent's local time; the roadmap hour (`H+n`) may be added in brackets.

## Rules

1. Additive only: new optional fields, new message types, new constants, new routes, new sync-client methods or events. Removing or renaming anything needs a human decision.
2. One concern per entry.
3. A question about the existing contract is also an entry; the answer may just point to a section of [02-protocol.md](02-protocol.md) and needs no version bump.
4. A request that blocks a gate for more than an hour is answered first; other answers land by the next checkpoint.
5. Until an answer lands, the requester builds against the contract as it is and stubs the gap locally inside its own tree.
6. Merge conflicts in this file are resolved by keeping both sides in order.

## Entries

### R-0 · 2026-09-19 22:00 · from frontend · status: done  (illustrative example — not a real request)
**Need:** an `ERROR` code for a full room so Player · Join can say "this hive is full" instead of a generic failure. **Why:** F1 error states; `MAX_PLAYERS = 64` exists but no code names the rejection. **Proposal:** add `ROOM_FULL` to the `ERROR.code` list in 02-protocol.md §5; the server sends it in reply to `JOIN` when the room has `MAX_PLAYERS` connected players; no new fields.
**Answer (backend):** accepted — `ERROR.code` is an open string set, so no `PROTOCOL_VERSION` bump; `ROOM_FULL` added to §5 and to the mock's `JOIN` handler behind a scenario knob. (commit: example)

Real entries start at R-1 below this line.

### R-1 · 2026-09-19 23:20 · from engine · status: done
**Need:** hand the server agent five things I learned building a full `apps/server` before the demo-first split moved it to them. **Why:** I built B0+B1 (REST + rooms + ws + NTP responder, 21 passing tests) against the old brief, an hour before `apps/server` became theirs. The code is out of my tree now, but four of these are bugs waiting to happen and one is a correctness issue for the demo. **Proposal:** no contract change. Reference implementation, if it is useful: branch **`reference/server-b0-b1`** (pushed; the remote here refuses tags) — `apps/server/src/{config,clock,library,rooms,room,rest,server,ws}.ts` plus `__tests__/{rest,room}.test.ts`. Take it, cherry-pick from it, or ignore it; it passes every check in the old B0/B1 gate rows including 20 simultaneous joins in ~180 ms.
**Answer (engine):** the five findings, most important first.

1. **`ROOM_STATE` coalescing must be leading-edge, not trailing.** The mock's `setInterval(flush, 500)` pattern delays every change by up to 500 ms. `LEAD_MS` is 600, so a `TRANSPORT PLAY` that waits 500 ms in the coalescer arrives with 100 ms of lead left and phones start ragged or skip the scheduled start entirely. Publish immediately when nothing was published in the last `1000/ROOM_STATE_MAX_HZ`, and put later changes inside that window on a trailing timer. Still ≤2 Hz. (My `Room.markDirty()`/`flush()` do this; `room.test.ts` asserts the first change goes out in <100 ms and that 12 back-to-back `SET_MODE`s do not become 12 broadcasts.) Scene boundaries (B6) should call `flush()` directly for the same reason.
2. **Stamp NTP `t1` as the first statement of the message handler, before schema validation**, and `t2` immediately before the send. Anything between them — a room lookup, a `JSON.parse` of a big frame — lands inside the client's `(t2 − t1)` and becomes clock error on every phone. Answer `NTP_REQUEST` before any authorization check, and never through the coalescer.
3. **`MAX_PLAYERS` must count *connected* players.** Records survive `DISCONNECT_RETENTION_MS = 120 s`, so counting all records lets 64 stale entries lock a room out for two minutes — and a room that people are re-joining is exactly when that happens. (This is what R-0 means by "connected players".)
4. **`CALIBRATION_REPORT` must drop measurements with `confidence < 0.5`** — the `sync-client` API documents 0.5 as the cutoff and `mock-server.ts` already enforces it (`d3527da`). Applying a low-confidence residual is worse than keeping the table value, because it moves a phone that was fine. Also: `calibration.order` must exclude every `plays:false` client (a controller host makes no sound to measure) and every disconnected one, and the server needs a failure timeout — if the reference never reports, `state` must go to `failed` or `host.startCalibration()` never resolves.
5. **Two smaller ones.** `GET /audio/:id/:stem.wav` should honour a single `Range` request: WebKit probes media with `bytes=0-1` and a 200 to a range request makes it retry or give up. And build the `urls` in `GET /tracks` from the *request* origin rather than a configured base, so the same binary serves `http://localhost:8080` and `https://<app>.fly.dev` with no env var.

Error codes my implementation emitted, for the frontend's error states (all inside the existing open `ERROR.code` string set — no version bump): `BAD_MESSAGE`, `NO_ROOM` (JOIN for a code with no room — the real server does **not** pre-create one, unlike the mock, so `POST /rooms` must happen first), `NOT_JOINED`, `NOT_HOST`, `FORBIDDEN` (a player nudging someone else, a non-reference reporting calibration, a host kicking itself), `NO_TRACK`, `ROOM_FULL`, `KICKED`. Two non-errors worth keeping: a `JOIN` claiming `kind:"host"` with a wrong `hostKey` is **demoted to a player** rather than refused, and a `protocolVersion` mismatch is **accepted** — `WELCOME.protocolVersion` carrying the server's value is how a stale bundle knows to reload.
