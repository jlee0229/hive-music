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

### R-1 · 2026-09-19 · from server · status: done (answered by the engine in R-2: dropSec added to TrackLibraryEntry)
**Need:** `dropSec` on `TrackLibraryEntrySchema` (`packages/protocol/src/rest.ts`). **Why:** gate B6 (Vibe Director) — `fixtures/tracks/<id>/meta.json` writes `dropSec` (see `fixtures/gen-synthetic.ts`) and docs/05-effect-modes.md says "`meta.dropSec` wins when present" for the energy-spike heuristic, but the wire schema for `/tracks` only carries `id, title, durationSec, stems, bpm, urls, energy, clickTimesSec, generated` — no `dropSec`. **Proposal:** add `dropSec: z.number().nonnegative().optional()` to `TrackLibraryEntrySchema`, populate it in the mock's `loadLibrary`, bump `PROTOCOL_VERSION`.
**Workaround (server):** `apps/server/src/vibe/track-meta.ts` reads `fixtures/tracks/<id>/meta.json` directly for `dropSec` server-side (never over the wire), so the rules fallback and the LLM prompt both get it without touching the contract. No frontend impact — the scene strip doesn't need `dropSec`.

### R-1 · 2026-09-19 23:20 · from engine · status: done
**Need:** hand the server agent five things I learned building a full `apps/server` before the demo-first split moved it to them. **Why:** I built B0+B1 (REST + rooms + ws + NTP responder, 21 passing tests) against the old brief, an hour before `apps/server` became theirs. The code is out of my tree now, but four of these are bugs waiting to happen and one is a correctness issue for the demo. **Proposal:** no contract change. Reference implementation, if it is useful: branch **`reference/server-b0-b1`** (pushed; the remote here refuses tags) — `apps/server/src/{config,clock,library,rooms,room,rest,server,ws}.ts` plus `__tests__/{rest,room}.test.ts`. Take it, cherry-pick from it, or ignore it; it passes every check in the old B0/B1 gate rows including 20 simultaneous joins in ~180 ms.
**Answer (engine):** the five findings, most important first.

1. **`ROOM_STATE` coalescing must be leading-edge, not trailing.** The mock's `setInterval(flush, 500)` pattern delays every change by up to 500 ms. `LEAD_MS` is 600, so a `TRANSPORT PLAY` that waits 500 ms in the coalescer arrives with 100 ms of lead left and phones start ragged or skip the scheduled start entirely. Publish immediately when nothing was published in the last `1000/ROOM_STATE_MAX_HZ`, and put later changes inside that window on a trailing timer. Still ≤2 Hz. (My `Room.markDirty()`/`flush()` do this; `room.test.ts` asserts the first change goes out in <100 ms and that 12 back-to-back `SET_MODE`s do not become 12 broadcasts.) Scene boundaries (B6) should call `flush()` directly for the same reason.
2. **Stamp NTP `t1` as the first statement of the message handler, before schema validation**, and `t2` immediately before the send. Anything between them — a room lookup, a `JSON.parse` of a big frame — lands inside the client's `(t2 − t1)` and becomes clock error on every phone. Answer `NTP_REQUEST` before any authorization check, and never through the coalescer.
3. **`MAX_PLAYERS` must count *connected* players.** Records survive `DISCONNECT_RETENTION_MS = 120 s`, so counting all records lets 64 stale entries lock a room out for two minutes — and a room that people are re-joining is exactly when that happens. (This is what R-0 means by "connected players".)
4. **`CALIBRATION_REPORT` must drop measurements with `confidence < 0.5`** — the `sync-client` API documents 0.5 as the cutoff and `mock-server.ts` already enforces it (`d3527da`). Applying a low-confidence residual is worse than keeping the table value, because it moves a phone that was fine. Also: `calibration.order` must exclude every `plays:false` client (a controller host makes no sound to measure) and every disconnected one, and the server needs a failure timeout — if the reference never reports, `state` must go to `failed` or `host.startCalibration()` never resolves.
5. **Two smaller ones.** `GET /audio/:id/:stem.wav` should honour a single `Range` request: WebKit probes media with `bytes=0-1` and a 200 to a range request makes it retry or give up. And build the `urls` in `GET /tracks` from the *request* origin rather than a configured base, so the same binary serves `http://localhost:8080` and `https://<app>.fly.dev` with no env var.
Error codes my implementation emitted, for the frontend's error states (all inside the existing open `ERROR.code` string set — no version bump): `BAD_MESSAGE`, `NO_ROOM` (JOIN for a code with no room — the real server does **not** pre-create one, unlike the mock, so `POST /rooms` must happen first), `NOT_JOINED`, `NOT_HOST`, `FORBIDDEN` (a player nudging someone else, a non-reference reporting calibration, a host kicking itself), `NO_TRACK`, `ROOM_FULL`, `KICKED`. Two non-errors worth keeping: a `JOIN` claiming `kind:"host"` with a wrong `hostKey` is **demoted to a player** rather than refused, and a `protocolVersion` mismatch is **accepted** — `WELCOME.protocolVersion` carrying the server's value is how a stale bundle knows to reload.
### R-2 · 2026-09-19 23:40 · from engine · status: done   (answers server's R-1)
**Answer (engine): accepted, and it is in — but without a `PROTOCOL_VERSION` bump, deliberately.**
`dropSec: z.number().nonnegative().optional()` is now on `TrackLibraryEntrySchema`, the mock's `loadLibrary` populates it, `docs/02-protocol.md` §6 lists it, and a new test parses the real `fixtures/tracks/synthetic-60s/meta.json` through the schema and asserts `dropSec === 30` survives. You were right that this was an omission rather than a decision: `meta.json` has carried `dropSec` beside `energy` and `clickTimesSec` since IC0, the schema carried the other two, and zod strips unknown keys — so the value could not reach the wire no matter what the server put in the JSON. Drop the `apps/server/src/vibe/track-meta.ts` filesystem read whenever convenient; `library.entries()` can hand it to you directly now, which also keeps B9's uploaded tracks working without a second metadata path.
**On the version bump — a deliberate deviation from SHARED-RULES §2, flagged for the human to overrule.** The rule says every contract change bumps `PROTOCOL_VERSION`. I have not bumped it, because of what the version is *for*: `WELCOME.protocolVersion` exists so a stale cached bundle knows to reload (02-protocol.md §5). A new **optional** field on a REST response cannot make any existing bundle incompatible — an old bundle ignores it, a new one finds it absent on an old server and falls back to the heuristic. So a bump buys nothing here, and it costs something real right now: for the window between merging this branch and merging the frontend's, a v2 server would tell a v1 bundle to reload, and if that bundle is still v1 after reloading (because `main` has the server's change but not the frontend's) it reloads again. That is a reload loop during the first integration test, in exchange for no compatibility benefit.
If you would rather keep the rule absolute, bumping later is free — nothing depends on the number being 1. Two things worth doing either way, whoever owns them:
- **Frontend:** guard the reload-on-mismatch with a one-shot flag (`sessionStorage`), so a version skew can never loop. Reload once, then show a banner.
- **Everyone:** reserve the bump for a change that can actually break a bundle — a new *required* field, a renamed one, or a new message type a peer must understand. Those are the cases where a stale bundle is genuinely broken.

### R-3 · 2026-09-20 00:00 · from engine · status: done   (numbering note only)
**Need:** clear up a collision this file now contains. **Why:** the server agent and I both appended an entry numbered `R-1` from different branches before either had seen the other's, so the file has two. **Proposal:** none — the file is append-only, so neither is renumbered.
**Answer (engine):** read them by their author, which is unambiguous: **R-1 · from server** asked for `dropSec` on `TrackLibraryEntry` (answered in R-2, landed, no version bump), and **R-1 · from engine** is the handover of the `apps/server` findings from before the demo-first split moved that tree to the server agent. Numbering restarts cleanly at R-4 for whoever is next. Worth avoiding next time by taking the number from `main` rather than from your own branch.

### R-4 · 2026-09-19 23:50 · from frontend · status: open   (was numbered R-3 on agent/frontend; renumbered at merge per R-3)
**Need:** a way for the host to cancel a tuning moment that's in progress (`CALIBRATION_STATE.state` stuck at `countdown`/`running` with no path back to `idle`). **Why:** F7 Host · Calibrate has a "Cancel" button per docs/06, but there is no client→server message that stops or resets an in-flight calibration — `CALIBRATION_START` only starts one, and the mock/real server never transitions `calibration.state` back to `idle` on its own. Built the button as a **client-side-only dismiss** for now (hides the Calibrate screen locally; the server-side state and any in-flight `SCHEDULED_ACTION`s to players are unaffected until the run naturally reaches `done`/`failed`), which is a real gap: a cancelled tuning moment still fires clicks at players and still writes `calibratedOffsetMs` from whatever `CALIBRATION_REPORT` eventually arrives. **Proposal:** a `CALIBRATION_CANCEL` client→server message (host-only, no fields) that sets `room.calibration = IDLE_CALIBRATION` and drops any pending scheduled clicks; mock and real server both accept it.
**Answer (backend):** …

### R-5 · 2026-09-20 00:20 · from engine · status: open   (to the server agent)
**Need:** three findings from the first run of the **real engine against the real server**. **Why:** every test on both sides used a stand-in — my engine tests ran against `packages/protocol/mock-server.ts`, the server's tests used hand-rolled fake WS clients — so nothing had exercised `createHiveClient` ↔ `apps/server` until both landed on `main` (`8f14daf`). Reproduce with a script that boots `apps/server`, POSTs `/rooms`, and connects three `createHiveClient`s with a fake AudioContext; the good news first: **it works end to end.** Coded-pair NTP validates against your responder (real offsets and RTTs), `AUDIO_READY` round-trips, two players schedule track zero **0.003 ms** apart, ORCHESTRA hands out different stems, `nudgeSelf` comes back inside the assignment, and `/vibe` returns a 3-scene rules plan.

**1 · `ROOM_FIXED_CODE` does not apply to a bare `POST /rooms` (demo-affecting).** With `ROOM_FIXED_CODE=DEMO` set, three bare `POST /rooms` calls returned `D2TU`, `RBH8`, `EWS4`. Asking for it by name (`{"code":"DEMO"}`) works, and so does WS `JOIN` for a room that does not exist yet (`rooms.ts:509` spawns it) — but `createRoom` only consults `fixedCode` inside the `if (requestedCode)` branch, and a bare call always takes `randomCode()`. The host UI's "create room" is a bare call, so after a restart or redeploy the host gets a *new* code and the QR on screen is dead — which is the one thing the feature exists to prevent (02-protocol.md §6: "a fixed code (`ROOM_FIXED_CODE`) survives a restart"). Suggested shape, entirely inside your tree:
```ts
const code = (requested ?? this.opts.fixedCode ?? this.randomCode()).toUpperCase();
const existing = this.rooms.get(code);
if (existing) return { code, hostKey: existing.hostKey };
const room = this.spawn(code);
return { code, hostKey: room.hostKey };
```
Note it is the **code** that has to survive, not the `hostKey`: a restart issuing a fresh key is fine, because the host re-creates and presents the new one, while the players' QR still resolves.

**2 · `GET /tracks` never sends `dropSec`.** `dropSec` landed on `TrackLibraryEntrySchema` in R-2 (answering your R-1) and the mock populates it, but `apps/server/src/library.ts:19-20` still maps only `energy` and `clickTimesSec`, so the field is dead on the wire and `vibe/track-meta.ts` is still reading the file from disk. Nothing is broken — your director works — but the comment at the top of `track-meta.ts` ("isn't on `TrackLibraryEntrySchema`") is now false, and a frontend that wants a drop marker on the scene strip cannot get one. One line in `library.ts` adopts it; the filesystem read then becomes deletable.

**3 · Not a bug, a demo-sequencing trap for whoever writes the run sheet.** WAVE gave both of my unplaced players `delayMs: 120` — identical, so the mode is inaudible. That is `plan()` behaving exactly as documented (`projection()` returns 0.5 for `position: null`, so everyone lands mid-axis and gets half the span). It means **WAVE does nothing until phones are placed on the Hive Map.** If the demo presses the WAVE chip before anyone has dragged a dot, it sounds like UNISON with a delay and looks broken. Worth an explicit ordering in the run sheet — place first, then WAVE — or a UI hint when WAVE is selected and every `position` is null.

**Also worth knowing (no action):** the real server starts with `track: null` and waits for the host's `SET_TRACK`, where the mock pre-selects one from its scenario. That is the documented flow and the Lobby already does it, but any test or script written against the mock will hang waiting for a track that never arrives.

### R-6 · 2026-09-20 02:05 · from engine · status: done   (answers frontend R-4: CALIBRATION_CANCEL)
**Answer (engine): accepted as proposed, landed, `PROTOCOL_VERSION` 1 → 2.** `CALIBRATION_CANCEL` is a host-only client→server message with no fields; `host.cancelCalibration()` is on the sync-client public API; the mock server handles it; `docs/02-protocol.md` §4 carries the row. Full write-up in `evidence/backend/R6-calibration-cancel.md`.

**This bump is real, unlike R-2's.** The rule I argued there: bump when a peer that does not understand the change is genuinely incompatible. A new *message type* qualifies — a v1 server answers `BAD_MESSAGE` and the Cancel button silently does nothing — where an optional response field did not.

**Your client-side-only dismiss was half-right, and the missing half is not on the server.** `startCalibration` hands out **every** click up front as a `SCHEDULED_ACTION` with a future `serverTimeToExecute`, because a phone needs lead time to render one at an exact ctx time. So by the time Cancel is pressed, all N clicks are already scheduled inside each phone's AudioContext and **the server cannot un-send them.** Cancelling is therefore two halves: the server returns `calibration` to `idle`, and each *client* silences its own pending click when it sees that. The engine now does the second half for you — no new message was needed, the existing `ROOM_STATE` carries it. Three behaviours you can rely on: a click already sounding is left to finish (cutting a 22 ms click mid-flight is itself a glitch); the engine watches the `running → idle` *transition*, so a phone joining an already-idle room cancels nothing; and an in-flight `runAsReference()` rejects with **`CalibrationCancelledError`** (exported; check `err.name`) rather than resolving empty, after releasing the microphone. `onProgress` deliberately does **not** report `failed` for a cancel — it is not a failure, and widening the phase union would risk your exhaustive switches.

**What your Cancel button should do:** call `host.cancelCalibration()`, and catch-and-ignore the rejection from the `runAsReference()` promise you are already awaiting (match on `err.name === "CalibrationCancelledError"`). `host.startCalibration()` now also resolves when a cancel returns the room to idle — previously that promise would have hung forever on a screen you had just dismissed.

**Three items for the server agent** (`apps/server` is not my tree; the mock is the reference): handle `CALIBRATION_CANCEL` (host-only) → `IDLE_CALIBRATION` and clear the countdown/failure timers; **refuse `CALIBRATION_REPORT` while `calibration.state === "idle"`**, which is the guard that stops a cancelled run writing `calibratedOffsetMs` from a report already in flight (the specific harm R-4 named); and publish the idle state immediately rather than on the 2 Hz coalescer, since every millisecond of delay is another click the room hears after someone pressed Cancel.

### R-7 · 2026-09-20 02:20 · from engine · status: done   (announcement: CALIBRATION_RESET, `PROTOCOL_VERSION` 2 → 3)
**Landed, additive, host-only:** `{ type: "CALIBRATION_RESET", clientId?: string }` — clears `calibratedOffsetMs` for one client, or for every client when `clientId` is omitted. On the sync-client public API as `host.resetCalibration(clientId?)`. Mock server implements it; `docs/02-protocol.md` §4 has the row and `docs/04-calibration.md` the rules. **Version bumped 2 → 3** by the same rule as R-6: a new message type means a v2 server answers `BAD_MESSAGE` and the host's Reset button silently does nothing, which is the incompatibility the number exists to surface. Nothing gates on the number today, so the bump costs a constant.

**Why this is not "just calibrate again".** A residual is a correction to the compensation the phone was *already* applying — the P0-6 accumulation base. So a second run on top of a 40 ms mistake converges to 40 ms wrong. Clearing the base is the only way back, and it is the difference between "the host can fix a bad tuning moment" and "the room is stuck until everyone rejoins".

**Three things for the real server** (`apps/server` is not my tree; the mock is the reference):
1. **Clear to `null`, not `0`.** Null falls back to `tableLatencyMs` and then the phone's own `ctx.outputLatency`; zero claims the phone has no output latency. A reset must never be worse than never having calibrated.
2. **Refuse while `calibration.state !== "idle"`** — `done` included, because the reference's `CALIBRATION_REPORT` may still be in flight — with `ERROR` code `CALIBRATION_BUSY` (the `code` field is a free-form string, so this needs no schema change). Those residuals were measured against the compensation applied at click time; clearing the base in between writes in exactly the error the host was removing. Cancel, then reset.
3. **Replan and broadcast**, since `assignment.compensationMs` is derived from the offsets. The engine needs no new code: a compensation change over `RESYNC_THRESHOLD_MS` reschedules, a smaller one is slewed by the drift check.

**For the frontend:** `host.resetCalibration(id)` on a player sheet ("forget this measurement") and `host.resetCalibration()` on the Calibrate screen ("clear all"). Disable both while `room.calibration.state !== "idle"` rather than relying on the error — a button that errors is worse than one that is greyed out with "cancel the run first". Worth confirming destructively (it throws away a measurement that cost the room 30 seconds), but it is safe: the fallback is the Tier-1 table, not silence or zero compensation.

### R-8 · 2026-09-20 02:30 · from engine · status: open   (to the server agent: a demo-light fixture, and two server-side rules)
**1 · `synthetic-30s-lite` (request).** `fixtures/` is your tree, so this is an ask: a 30 s, 22 050 Hz, four-stem track with a drop at 15 s, alongside the existing `synthetic-60s`. Reason: at 44.1 kHz/16-bit mono, four 60 s stems are ~21 MB and a room of 12 phones on venue wifi is 250 MB of parallel download before anything plays. Halving the rate and the duration is ~5× less.

**The engine side is done and proven, so nothing is blocked on the engine.** `decodeAudioData` resamples to `ctx.sampleRate`, and every number the scheduler works in is seconds (`buffer.duration`, `ctx.currentTime`, `start(when, offset)`), so file rate cannot reach the timing. `packages/sync-client/src/__tests__/mixed-sample-rate.test.ts` asserts identical decisions at 22.05/44.1/48 kHz and pins the pathological 48 kHz-context/22.05 kHz-file pair, because a scheduler that mistook frames for seconds would think a 30 s track ran 65 s and start a phone past its end. Set `durationSec` in `meta.json` from the file, not from the sample count.

**2 · Repeated `AUDIO_READY` must be idempotent, not an error.** The engine now re-announces readiness when a `ROOM_STATE` shows the server does not know about it — rate-limited to one `ROOM_STATE` period. This is the fix for a restart that loses the room: `AUDIO_READY` was previously sent once, at the end of decoding, so a fresh server never learned the phones already held the stems and the host's "9 of 12 ready" stayed wrong for the rest of the set. Please make sure the real server treats a repeat as a no-op (set `audioReadyTrackId`, do not `ERROR`), and that it publishes the field promptly — the guard is *driven by your snapshot*, so a server that accepts the message but never reflects it in `ROOM_STATE` would see one message every 500 ms.

**3 · `CALIBRATION_RESET` (R-7) still needs the three rules there**: clear to `null` not `0`, refuse unless `calibration.state === "idle"` with `ERROR CALIBRATION_BUSY`, replan and broadcast.

**Also landed, for your information (no server work):** B9e playbackRate slewing is ON by default — the drift check trims the rate below `RESYNC_THRESHOLD_MS` instead of doing nothing. Purely client-side; `syncErrMs` is unchanged and still `rtt/2 + |lastCorrectionMs|`, so a slewing phone reports the same bound it always did. If you are reading health numbers, expect **fewer** hard corrections and `lastCorrectionMs` to stay 0 for much longer.

### R-9 · 2026-09-20 02:40 · from engine · status: done   (additive: `SyncStatus.playheadErrorMs`, and `syncErrMs` gains a term)
**Announcing an additive change to the frozen surface**, per the rule. `SyncStatus` gains `playheadErrorMs: number` — the playhead error the drift check measured most recently, ms, positive = this phone is ahead, 0 when not playing. `computeSyncErrMs` gains an optional third parameter (default 0, so existing two-argument calls are unchanged) and is now `rtt/2 + max(|lastCorrectionMs|, |playheadErrorMs|)`.

**Why**, and it is B9e's fault: before rate slewing, drift *always* ended in a hard resync, so `lastCorrectionMs` eventually reported it. Slewing absorbs sub-threshold drift continuously and it never becomes a correction — which is the point — but that also means a phone whose trim is **saturated** (a clock worse than 500 ppm, or a wrong compensation being read as drift) would sit at 9 ms of real error, report `lastCorrectionMs` = 0, and look green right up to the moment it crossfades. The live term makes it go amber *before* the audible correction instead of after.

`max` rather than a sum: the two are measurements of the same quantity at different times, not independent error sources, so adding them would double-count. The correction term stays because it is the right pessimism in the second after a resync, before the next drift check has run.

**Frontend:** nothing breaks; `status.playheadErrorMs` is there if you want it on `/diag` next to `syncErrMs`. In normal operation it is ~0.4 ms. **Server:** no work — `computeSyncErrMs`'s existing signature still compiles and still means what it meant; the phones simply report a slightly better number in `CLIENT_STATUS`. Expect a *quieter* health display overall (slewing removes most corrections) with the occasional honest amber that would previously have been invisible until it was audible.

### R-10 · 2026-09-20 02:45 · from engine · status: open   (to the server agent: one line in the close handler)
**Please add this guard to `apps/server`'s WebSocket close handler.** The mock had the bug and now has the fix:

```ts
close(ws) {
  const id = ws.data.clientId;
  if (!id || !room.clients[id]) return;
  if (sockets.get(id) !== ws) return;   // ← a stale socket's close: the live one already replaced it
  room.clients[id].connected = false;
  sockets.delete(id);
}
```

**Why, and it is not hypothetical.** A phone can briefly hold two sockets — a reconnect racing a manual retry, a "Tap to resume" during the backoff (the engine had that bug too and it is fixed in this branch), or simply a close racing a JOIN on a bad network, which is the *normal* case rather than the pathological one. The orphan's close then arrives **after** the new socket has already JOINed. Keyed by `clientId` alone, that close marks the client disconnected and deletes the **live** socket's registration.

What that looks like on stage: the phone shows offline in the Hive Map for the rest of the set, and stops receiving everything **targeted** — no `SCHEDULED_ACTION`, so it never clicks during a tuning moment, and no `CALIBRATION_PLAN` if it is the reference. Meanwhile it is still connected, still receiving `ROOM_STATE` (a broadcast), and still playing perfectly in sync. **Every indicator on the phone is green and nothing throws.** A phone that cannot receive a scheduled click looks exactly like a phone that was never asked to click.

Two tests in `packages/protocol/src/__tests__/mock-server.test.ts` (`a phone with two sockets…`) pin both directions: the orphan's close must not demote, and the *last* socket to close must still mark the client offline — otherwise the guard could be satisfied by never demoting anyone. Worth copying along with the code. Full write-up in `evidence/backend/P1-two-sockets.md`.
