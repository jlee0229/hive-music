# F8 — status and an early integration pass against the real server

**Blocked on the engine agent:** `createHiveClient()` in `packages/sync-client/src/index.ts` still throws
`"not implemented yet"` (checked against `origin/main` at commit `40efbdf`, which merged server v1 —
`apps/server` — but not the engine/B2-B4/B8e work). F8 explicitly needs `NEXT_PUBLIC_HIVE_ENGINE=real`,
so it cannot run yet; this file records what *is* verified in the meantime and stays until the engine
lands, at which point F8's actual Playwright-observable half (stub-vs-real UI parity) plus the phone
half (unison/orchestra/vibe/tuning across 3+ real phones) can run for real.

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

## What's still open for the real F8

- `NEXT_PUBLIC_HIVE_ENGINE=real` needs `createHiveClient()` implemented (engine agent, gates B2–B4/B8e).
- The phone half (3+ real devices in unison, one stems mode, one vibe plan, one tuning moment, on video)
  needs real hardware, which this environment doesn't have — same constraint as F1/F3/F9's phone checks.
