# Frontend agent brief — host mode and player mode UI

**Model:** Claude Sonnet 5. **Branch:** `agent/frontend`. **Rules:** [SHARED-RULES.md](SHARED-RULES.md) apply in full.

## Mission

Build the Next.js PWA that a host runs on their phone and that every phone in the crowd opens from a QR code: the join flow,
the full-screen player screen, the host's stage with the **Hive Map**, the tuning-moment flow and the vibe box. You build
against the **mock server** and the **stub client** from minute one; the real engine slots in behind the same API at IC1/IC2.
The visual reference is the design canvas; the functional contract is `docs/06-hive-map-ui.md`.

## Read first (in this order, ~20 minutes)

1. [SHARED-RULES.md](SHARED-RULES.md)
2. [docs/06-hive-map-ui.md](../docs/06-hive-map-ui.md) — every screen, state and message you own; the design canvas link is at the top
3. [docs/02-protocol.md](../docs/02-protocol.md) — what `ROOM_STATE` contains and what each host action sends
4. `packages/sync-client/src/index.ts` — the API you call (`createHiveClient` is not implemented yet; `createStubClient` is)
5. [docs/00-context.md](../docs/00-context.md) §pitch and [docs/05-effect-modes.md](../docs/05-effect-modes.md) — what the modes mean so the copy is honest
6. [docs/08-roadmap.md](../docs/08-roadmap.md) — checkpoints and the 3-minute demo script your screens must carry
7. Run `bun install && bun run fixtures && bun run mock --scenario apps/web/mocks/scenarios/party-12.json` and, in a second terminal, `bun run --cwd apps/web dev`.

## You own / you never touch

Own: `apps/web/**` (including `apps/web/mocks/scenarios/*.json`, `apps/web/e2e/**`), `evidence/frontend/**`, this file's gate table.
Never: `apps/server`, `packages/*`, `fixtures`, `infra`, `docs/**` (except appending to `docs/PROTOCOL-REQUESTS.md` and your rows in `docs/08-roadmap.md`).

## What already exists (IC0)

- `apps/web`: Next.js 15 app router + Tailwind v4 scaffold, `app/layout.tsx`, placeholder `app/page.tsx`, `public/manifest.webmanifest`,
  three mock scenarios. `next.config.ts` transpiles the two workspace packages.
- `@hive/protocol`: `ROLE_COLORS`, `HEALTH_COLORS`, `healthLevel()`, `evaluatePattern()`, `activeSceneIndex()`, `trackTimeSec()`, every type.
- `@hive/sync-client`: `createStubClient(opts)` — real WebSocket, real clock sync, host controls, reconnect with backoff, `audio.unlock()`
  that fakes a 4-part download; no sound. `detectDevice()`.
- The mock server: `bun run mock --scenario <file>` on `:8080`; REST + WS; seeded players with synthetic health; simulated tuning moment
  (`CALIBRATION_PLAN`, per-player results every 400 ms); `POST /rooms/:code/vibe` returns a 3-scene plan; `restart.json` drops every
  socket after 20 s.

## Architecture inside `apps/web` (keep it this simple)

```
app/page.tsx                 landing
app/j/[code]/page.tsx        player mode (Join → Ready → Playing → Calibrating, one component with a state switch)
app/h/[code]/page.tsx        host mode (Lobby → Stage; sheet, calibrate, players as overlays/routes)
app/diag/page.tsx            diagnostics
lib/hive/client.ts           createClient(opts): picks createStubClient or createHiveClient by NEXT_PUBLIC_HIVE_ENGINE=stub|real
lib/hive/useHiveClient.ts    the one hook: connects once, exposes { client, room, me, status, connection, audio, health }
lib/hive/derive.ts           pure helpers: healthFor(id), sceneNow(), beatPhase(), stems(room)
components/HiveMap.tsx       <svg> or <canvas>; dots, rings, drag (pointer events), tap, long-press
components/…                 TransportBar, ModeChips, VibeBox, SceneStrip, NudgeSlider, RingerBanner, ReconnectBanner
e2e/*.spec.ts                Playwright against the mock + stub
```

Rules: one `useHiveClient` per page; every render reads the latest `room` snapshot; 60 fps visuals read `client.clock.trackTimeSec()`
in `requestAnimationFrame`; colors only from `ROLE_COLORS`/`HEALTH_COLORS`; positions normalized 0..1 both ways; `setPosition` on
every pointer move (the engine throttles to 10 Hz) and once more on release; nudge sliders send on release, debounced 150 ms.

## Engineering notes

- **Unlock inside the gesture.** `audio.unlock()` must be called synchronously in the tap handler (before any `await`), then `connect()`.
  If `audio` falls back to `locked` later (iOS interruption), show the tap button again.
- **iOS ringer banner** only when `detectDevice().browserFamily === 'ios-safari'`. Copy is in the doc; keep it.
- **Wake lock** is requested by the engine; show "keep your screen on" copy anyway.
- **Start gating:** the Lobby's Start button is enabled when every *connected* player has `audioReadyTrackId === room.track.id`; after
  10 s show "start anyway" (the engine starts late joiners mid-track correctly).
- **Hive Map:** unplaced clients (`position === null`) are laid out along the bottom edge with a hint; drag lifts them onto the map.
  Host dot hollow/dashed; do not let it be dragged into the planner (it is not a speaker unless `plays`). Ring color from
  `healthLevel(health[id], serverNow)` using the `HEALTH` event (hosts get it at 1 Hz); players show their own `status.syncErrMs`.
  WAVE: brightness = `evaluatePattern(assignment.pattern, trackTimeMs)`; STROBE: same, blinking by group.
- **Scene strip:** widths proportional to scene durations; `activeSceneIndex(room.scenePlan, trackTimeSec)` highlights; `host.vibe()` shows a
  spinner ≤5 s (the server falls back to rules itself).
- **Reconnect:** `connection === 'reconnecting'` → banner; the stub/engine reconnects with backoff and the server restores the slot by
  `clientId`. Test it with `restart.json`.
- **PWA:** manifest + icons only. No service worker (stale bundles during a hackathon are worse than no offline).
- **Playwright:** `bun add -d @playwright/test` inside `apps/web`; Chromium is preinstalled at `/opt/pw-browsers/chromium` in the cloud
  environment (`executablePath` if the default download is blocked). Tests start the mock with a scenario on a random port, set
  `NEXT_PUBLIC_WS_URL`/`NEXT_PUBLIC_API_URL`, and use the stub engine; assert on **messages** by reading `mock.room` through a tiny
  `/__mock/state` route if you add one to *your* test harness (never to the mock itself — request it instead if you need it).
- **Phone checks** (F1, F3, F8) cannot be automated: open `/diag` on the phone, screenshot, and put the checklist in the evidence file.

## Ordered tasks and gates

> **Demo-first order (revised):** F0 → F1 → F2 → F3 → F4 → F5 → F6 → **F9** (deploy prep + restart recovery, pulled forward so the
> Vercel project is live before the first phone test) → **F8** (first full real test with `NEXT_PUBLIC_HIVE_ENGINE=real` once the
> engine's INT PR is on `main`) → **F7** (tuning-moment screens, second round). Open a PR to `main` after F3 (IC1: join/ready/playing on
> the deployed stack) and after F6.

Update the **status** column as you go (⬜ not started · 🟨 in progress · ✅ passed · 🟡 needs human · ❌ blocked → request written).

| gate | deliverable | check | evidence | status |
|---|---|---|---|---|
| **F0** | scaffold runs on the mock: `lib/hive/*`, `useHiveClient`, tokens in `globals.css`, landing `/`, `/diag` | `bun run --cwd apps/web typecheck` + `lint` green; `/diag` shows clientId, connection `open`, rtt, offset, `audio` state against `party-12.json` | `evidence/frontend/F0-diag.png` | ✅ |
| **F1** | Player · Join + Ready: name (persisted), ringer banner (iOS only), Tap to join → `audio.unlock()` + `connect()`, sync ring with `syncErrMs`/`rttMs`, stem progress, "You'll play" card, waiting/keep-screen-on copy, reconnect banner | Playwright: join reaches Ready with `audio === 'ready'` and the role card shows the assignment color; **phone:** iOS Safari + Android Chrome reach Ready against the mock (screenshots + `/diag`) | `F1-ready.png`, `F1-phones.md` | 🟡 needs human (Playwright ✅; no physical phones in this environment) |
| **F2** | Host · Lobby (`POST /rooms`, QR via `qrcode`, joined dots, speaker toggle → `setPlays`, library search `GET /tracks?q=`, select → `setTrack`, Start gating → `play(0)`) + Stage transport bar (pause/play/seek, time from `clock.trackTimeSec()`) | Playwright: search filters the list; Start sends `TRANSPORT PLAY` and the bar starts moving; the QR decodes (use `jsqr` in the test) to `/j/BZQ7` | `F2-lobby.png`, `F2-stage.png` | ✅ |
| **F3** | Player · Playing: full-screen `assignment.color`, pulse from beat (`bpm`) and `evaluatePattern`, role label, title/time, sync pill, nudge slider (sends `nudgeSelf` on release), mute; paused/ended states | Playwright: `ASSIGN` from a host client changes the color; nudge release sends `NUDGE` once; **phone:** visibility change → still shows the right time after resume | `F3-playing.png`, `F3-phone.md` | 🟡 needs human (Playwright ✅; no physical phones in this environment) |
| **F4** | Hive Map v1: dots at positions, unplaced row, drag → `setPosition` (normalized), tap-to-cycle → `assign`, long-press → Player sheet (pills, pin, nudge, kick), hollow host dot, legend from `ROLE_COLORS`, health rings from `healthLevel` | Playwright with `party-12.json`: 12 dots render; dragging a dot emits `SET_POSITION` with `0 ≤ x,y ≤ 1`; tapping cycles the role; legend entries equal `Object.keys(ROLE_COLORS)` | `F4-map.png` | ✅ |
| **F5** | Mode chips → `setMode`; WAVE sweep and STROBE blink animated on the map and on player screens via `evaluatePattern` on the shared clock | Playwright: each chip sends `SET_MODE` with the right kind; visual check recorded | `F5-modes.mp4` (gitignored) + `F5-modes.md` | ✅ |
| **F6** | Vibe box + Direct → `host.vibe()`; scene strip from `room.scenePlan` with the active scene highlighted; manual chip clears the plan | Playwright: submit → `POST /rooms/BZQ7/vibe`; strip shows 3 scenes; highlight moves as time advances | `F6-vibe.png` | ✅ |
| **F7** | Host · Calibrate flow (`startCalibration`, rows from `room.calibration`, Apply/Cancel) + Player · Calibrating (countdown, flash on `calibrationClick`, N-of-M dots) | Playwright with `calibrating.json`: rows render waiting/listening/clear; the player screen flashes on the event | `F7-calibrate.png` | ✅ |
| **F8** | end to end against the **real** server (joint with backend B3/B5/B8): `NEXT_PUBLIC_HIVE_ENGINE=real` | **phones:** 3+ phones in unison from the host phone, one stems mode, one vibe plan, one tuning moment; video | `F8-e2e.md` (+ video, gitignored) | 🟡 needs human (phones) — the real engine merged; join/ready/audio-ready/start/map/mode/vibe/tuning all verified headlessly against the real server + real engine (2 real bugs found and fixed along the way); only audible multi-phone sync remains, see `F8-notes.md` |
| **F9** | manifest + icons, error states (`NO_ROOM`, `KICKED`), restart recovery UI, Vercel deploy with env pointing at Fly | Playwright with `restart.json`: banner appears at 20 s and clears within 5 s with the same `clientId`; Vercel URL loads on a phone | `F9-restart.png`, `F9-deploy.md` | 🟡 needs human (Playwright ✅ incl. manifest/icons/error states; no Vercel/Fly credentials in this environment) |

Work in the demo-first order quoted above the table. IC1 needs F0–F3 on the deployed stack; the first full test needs F4–F6 + F9 + F8; F7 is the second round.

## When to write to `docs/PROTOCOL-REQUESTS.md`

Whenever a screen needs a field, message or sync-client method that does not exist — for example a `HEALTH` field, a `KICKED`
reason, a `loadProgress` per stem. Write the entry, build the screen with a placeholder, move on. Never add a raw WebSocket or
touch `packages/*` to get around it.
