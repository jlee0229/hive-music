# F8 — real server, then real engine, both verified headlessly; phones still needed

**Update:** the engine agent's `createHiveClient()` merged (`origin/main` commit `cd8e8e3`, "Merge engine
v1: clock, scheduler, audio engine, modes, drift") shortly after the note below was first written. Ran
the automatable half of F8 for real — `NEXT_PUBLIC_HIVE_ENGINE=real` against the real `apps/server` — and
it passes headlessly (see "Real engine, for real" below). What's left is genuinely phone-only: audible
sync across 3+ physical devices, which this environment cannot provide.

## Blocked-on-hardware summary (current state)

Everything Playwright can observe about the real engine + real server, this environment has now
verified: WebSocket/NTP handshake, real `AudioContext` + real `decodeAudioData` on the actual fixture
WAVs (4/4 parts, not a faked download), `AUDIO_READY`, transport scheduling with a moving clock, the
Hive Map against a real client, a real `SET_MODE` round trip, a real rules-fallback `POST …/vibe`, and a
real `startCalibration()` → `CALIBRATION_PLAN`/`SCHEDULED_ACTION` → Player Calibrating flash. What
remains — and can *only* be done on hardware — is audible device-to-device sync judged by a human ear
across 3+ real phones on one Wi-Fi network, one stems mode, one vibe plan, and one tuning moment, on
video. See "What a human must do" at the end of this file.

## Original note (kept for the record): why F8 was blocked before the engine merged

`createHiveClient()` in `packages/sync-client/src/index.ts` used to throw `"not implemented yet"`
(checked against `origin/main` at commit `40efbdf`, which merged server v1 — `apps/server` — but not yet
the engine/B2-B4/B8e work). F8 explicitly needs `NEXT_PUBLIC_HIVE_ENGINE=real`, so it could not run at
that point; the section below records what was verified against the real *server* in the meantime, with
the engine still stubbed.

## What I did anyway: smoke-tested apps/web against the real `apps/server` (still stub engine)

Once `apps/server` (B0/B1/B5s/B6/B8s) merged to `main`, I ran the whole frontend against it — REST +
WebSocket, `NEXT_PUBLIC_HIVE_ENGINE` still `stub` (no real audio, since the engine isn't there yet) — as
a protocol-compatibility check ahead of F8, not a gate in itself. Kept as
`apps/web/e2e/manual/real-server.spec.ts` (excluded from the mock-driven suite; self-skips when the real
server isn't reachable on `:8080`, so it's harmless in a normal `bunx playwright test` run). Run it with:

```
ROOM_FIXED_CODE=BZQ7 CORS_ORIGIN=http://localhost:3000 bun run --cwd apps/server dev
bun run --cwd apps/web dev
cd apps/web && bunx playwright test e2e/manual/real-server.spec.ts
```

This caught two real bugs in `apps/web` that the mock server's leniency had been hiding:

1. **`SET_TRACK` was never actually sent.** The Lobby auto-selects the first library track visually
   (so the radio shows a checked default), but only called `client.host.setTrack()` inside the radio's
   `onChange` handler — which never fires for an option that's already checked. Every mock scenario
   pre-seeds `room.track` at startup, so this never showed up in gates F0–F7. Against a fresh real room
   (`track: null`), "Start the hive" would have sent `TRANSPORT PLAY` into a room with nothing loaded.
   Fixed in `app/h/[code]/page.tsx`: a dedicated effect now pushes `host.setTrack()` the moment the room
   exists with `track: null` and a library entry is available (and syncs local state to `room.track`
   when one already exists, e.g. on reconnect).
2. **`JOIN` never carried the player's name.** `useHiveClient`'s `useMemo` building `HiveClientOptions`
   didn't list `opts.name` (or `opts.plays`) in its dependency array, so the memoized object — and the
   "rebuild the client if the name changed before connecting" guard that depends on comparing it — never
   actually saw a new name after the first render. The Ready/Playing screens render the *locally typed*
   name, so this was invisible there; it only became visible once the real server's own `ClientRecord.name`
   (which falls back to `"Phone N"` without a `JOIN.name`) showed up on the Host Calibrate rows and the
   Player Calibrating header — both read `me.name`/`room.clients[id].name` from the server, not local
   state. Fixed by adding `opts.name`/`opts.plays` to the `useMemo` dependency array in
   `lib/hive/useHiveClient.ts`.

Also hit and diagnosed (not a bug, working as intended): `POST /rooms` with an explicit `code` that
isn't the server's `ROOM_FIXED_CODE` returns `400 unknown room code` — the real server only accepts an
arbitrary requested code when it already has a room by that code, or when it matches `ROOM_FIXED_CODE`.
The mock is more lenient (any `code` returns its one scenario room) for dev convenience. This only
matters when navigating directly to `/h/<code>` without ever having created it via Landing's own
`POST /rooms {}` (which the primary "Host a hive" flow already does, and which is exempt since it never
requests an existing code); it's exactly the fixed-code behavior `docs/07-tech-stack.md` describes for
the demo, so no frontend change was needed — just set `ROOM_FIXED_CODE` to match the QR code in
deployment (see `F9-deploy.md`).

After both fixes: host Lobby renders the real track library, a real player reaches Ready/Playing with
the right assignment color and clock sync numbers, Start correctly loads the track and moves the
transport, the Hive Map renders the real host + player dots, and a real `startCalibration()` run shows
live Host Calibrate rows and flashes the Player Calibrating screen — all against `apps/server`, not the
mock. No console/page errors in either the host or player context.

## Real engine, for real: `NEXT_PUBLIC_HIVE_ENGINE=real` against the real server

Once the engine merged, ran the frontend against **both** real pieces — real `apps/server`, real
`createHiveClient()` — headlessly. Kept as `apps/web/e2e/manual/real-engine.spec.ts` (same self-skip
pattern; harmless in a normal `bunx playwright test` run). Run it with:

```
ROOM_FIXED_CODE=BZQ7 CORS_ORIGIN=http://localhost:3000 bun run --cwd apps/server dev
NEXT_PUBLIC_HIVE_ENGINE=real bun run --cwd apps/web dev
cd apps/web && bunx playwright test e2e/manual/real-engine.spec.ts
```

Passes clean on a fresh room (~8s): a real player's `audio.unlock()` actually downloads and decodes the
4 real fixture WAVs (`"4 / 4 parts"`, not the stub's faked 480ms timer) and reaches `audio.state ===
'ready'`; the real clock-sync numbers populate (`status.syncErrMs`); Start actually loads
`SET_TRACK`/`TRANSPORT PLAY` through the real room manager and scene/transport scheduler, and the
transport clock visibly advances; the Hive Map renders the real host + real player; a mode chip drives a
real `SET_MODE` through the real planner; the vibe box's `Direct` hits the real
`POST /rooms/:code/vibe` (rules fallback — no `ANTHROPIC_API_KEY` in this environment) and the scene
strip renders 3 real scenes; `startCalibration()` drives a real `CALIBRATION_PLAN`/`SCHEDULED_ACTION`
round trip that flashes the real player's Calibrating screen. No console/page errors in either context.

This is as far as F8 goes without hardware: everything above is proof the wiring, message shapes, and
UI reactions are correct end-to-end. It is **not** proof of audible sync — a headless browser has no
speaker for a human to judge fusion against, and `SYNC_TARGET_MS`/`SYNC_FLOOR_MS` are perceptual
thresholds that only mean something with real devices in a real room.

## What a human must do (phones), in priority order

1. **3+ real phones, one Wi-Fi/hotspot**, `NEXT_PUBLIC_HIVE_ENGINE=real`, pointed at a deployed (or
   LAN-reachable) `apps/server` with `ROOM_FIXED_CODE` set to the QR code's room. Host creates the hive,
   phones join via the QR, Start — confirm by ear that UNISON sounds like one source, not a crowd of
   phones (the ≤10ms target / ≤30ms floor from `docs/00-context.md`'s error budget).
2. Switch to ORCHESTRA (or another stems mode) with no reload; confirm each phone plays a distinct,
   audible stem and the Hive Map's dot colors match what's actually coming out of each phone.
3. Submit a vibe prompt; confirm the scene strip's boundaries land audibly in time with the track (the
   scene timer's `LEAD_MS` compensation) and every phone switches mode at the same instant.
4. Run one tuning moment (`Tune the hive` from the host phone) with real mics releasing/re-acquiring
   correctly; confirm the Host Calibrate rows track real `waiting → listening → clear` transitions and
   the offsets it applies audibly tighten sync afterward.
5. Record video of the above (per the roadmap's rehearsal exit criterion) and drop it into
   `evidence/frontend/` (gitignored — reference it from a short `.md` per `agents/SHARED-RULES.md` §7,
   the same pattern as `F5-modes.md`/`F5-modes.webm`).

This is the same phone dependency as F1/F3/F9 — this environment has no physical devices — but F8 is the
one gate where it's not optional: everything that *can* be verified without a phone, is (see above).
