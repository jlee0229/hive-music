# HiveMusic — Roadmap, Gates and Demo Script

Owner: both (each agent updates only its own rows in the status table)

Roughly 18 build hours from IC0. Two agents on two branches (`agent/backend`, `agent/frontend`) meet at four integration checkpoints and a rehearsal. Gate definitions with runnable checks and named evidence files are in `agents/BACKEND-AGENT.md` and `agents/FRONTEND-AGENT.md`; this doc is the timeline, the scoreboard, the cut list and the demo script. Context: [00-context.md](00-context.md); contract: [02-protocol.md](02-protocol.md); rules: `agents/SHARED-RULES.md`.

## Hour plan

| Hour | Backend (Opus 5) | Frontend (Sonnet 5) | Joint |
|---|---|---|---|
| H+0 | IC0 is on `main`: protocol v1, planner, mock, stub client, sync-client API types, fixtures generator, docs. Start **B0**: verify scaffold; `apps/server` serves `/health`, `/rooms`, `/tracks?q=`, `/audio` from `fixtures/tracks` with CORS | Start **F0**: Next.js scaffold on the mock, `lib/useHiveClient.ts` over `createStubClient`, `/diag`, landing `/` | **IC0** |
| H+1 | B0 done (`bun run typecheck && bun run test` green; curl transcript). Deploy the stub to Fly now — cloud from hour one; B7 is the hardening pass later | F0 | |
| H+2 | **B1**: rooms, `JOIN`/`WELCOME`, NTP responder, coalesced `ROOM_STATE`, `HEALTH` to hosts, reconnect-by-`clientId`, fixed code, `plays` toggle, `SET_TRACK` | F0 done (lint/typecheck green; `/diag` screenshot). Start **F1**: Player · Join + Ready — unlock, stem progress, synced state, ringer banner, reconnect banner | |
| H+3 | B1 | F1 | |
| H+4 | B1 done (3 fake WS clients; `t1 ≤ t2`; snapshot lists players; rejoin keeps id; 20 simultaneous joins). Start **B2**: clock model — min-RTT, coded probes, sliding window, 1 Hz — plus serverTime↔ctx mapping | F1 | |
| H+5 | B2 | F1 done (`audio.state === 'ready'` and `health good` on iOS Safari + Android Chrome; 30 s `/diag` checklist + screenshots). Rebase, PR to `main` | |
| H+6 | B2 done (fake transport +137 ms / ±30 ms jitter / 20 % spikes → within 2 ms over 30 probes). Rebase, PR | **IC1** | **IC1** |
| H+7 | **B3**: transport-derived scheduling (PLAY/PAUSE/SEEK, late join, `AUDIO_READY`, unlock, `interrupted`/visibility resync) + the **measurement rig** | **F2**: Host · Lobby (QR of `joinUrl`, fixed code, speaker toggle, library search, track select, Start) + Stage transport bar | |
| H+8 | B3 | F2 | |
| H+9 | B3 done (rig: two devices within 10 ms after table compensation; ctx-mapping unit test; server restart → rejoin + resume within 5 s). Start **B4**: hard-resync drift, 4-row latency table, nudge → compensation | F2 done (Playwright on mock: play → `TRANSPORT`; `?q=` filters; QR decodes to the join URL). Start **F3**: Player · Playing — role colour, beat pulse, nudge slider, wake lock, pattern flash | |
| H+10 | B4 | F3 | |
| H+11 | B4 done (rig <10 ms at t=0 and t=5 min; +40 ms nudge → 40±3 ms; +50 ppm within 5 ms). Rebase, PR | F3 done (assignment change → colour; wake lock requested; correct after visibility resume). Rebase, PR | **IC2** |
| H+12 | **B5**: planner completion (5 modes, pin-aware, stable, host `plays` respected), pattern eval in sync-client, stems fixtures | **F4**: Hive Map v1 — dots, drag → `SET_POSITION` 10 Hz, tap-to-cycle → `ASSIGN`, hollow host dot, legend, health rings, player sheet | |
| H+13 | B5 done (planner tests: determinism, no reshuffle on join, pins win, non-playing host excluded; mode switch = gain ramps only). Start **B6**: Vibe Director — `ScenePlanCoreSchema` call, `POST …/vibe`, scene timer, `VIBE_MODEL`, rules fallback | F4 done (drag emits normalised coords; legend matches `ROLE_COLORS`; 20-client scenario renders). Start **F5**: mode chips; WAVE/STROBE animation via `evaluatePattern` on the shared clock | |
| H+14 | B6 | F5 done (visual + message assertions). Start **F6**: vibe box + scene strip from `room.scenePlan`, current scene via `activeSceneIndex` | |
| H+15 | B6 done (10/10 schema-valid; "calm then explode at the drop" → ≥2 scenes; fallback with key unset). Rebase, PR | F6 done (submit → POST; strip renders the mock plan). Rebase, PR | **IC3** |
| H+16 | **B7**: Fly hardening — always-on, `bos`, 20 s `PING`; `/health` 200 over HTTPS; phone joins + syncs over WSS. Start **B8**: Tier 2 calibration with the host phone as listener | **F7**: Host · Calibrate flow + Player · Calibrating (driven by `calibration.runAsReference` and `calibrationClick`); `calibrating` scenario renders rows/progress. Start **F8**: end-to-end vs the real server | |
| H+17 | B8 done (synthetic delay within 1 ms; real +40 ms nudge recovered ±5 ms; mic released). Rebase, PR. Apply the cut list | F8 done (3+ phones unison + one stems mode + one vibe plan; host phone calibrates; video). Rebase, PR | **Rehearsal** |
| H+18 | **B9** (stretch) only if everything above is green; otherwise evidence + README | **F9**: manifest + icons (no SW), error states, restart recovery (`restart.json` → banner → recovers within 5 s); evidence + video | Demo |

## Checkpoints

Each checkpoint is a merge of both branches to `main` with the root green (`bun run typecheck && bun run test`), followed by one joint demo-able check. If the check fails, both agents stop feature work until it passes; a slip of more than one hour triggers the cut list.

| Checkpoint | When | Gates in | Joint demo-able exit criterion |
|---|---|---|---|
| **IC0** | done before the agents start | protocol v1, planner, mock, stub client, sync-client API types, fixtures generator, docs | `bun run mock --scenario apps/web/mocks/scenarios/party-12.json` + a scripted WS client completes `JOIN → WELCOME → NTP → ROOM_STATE` with assignments for players and none for the non-playing host; `GET /audio/synthetic-60s/drums.wav` serves; `GET /tracks?q=syn` filters; the schema test diffs every message in [02-protocol.md](02-protocol.md) against `messages.ts`; the numbers in the docs are the numbers in `constants.ts` |
| **IC1** | ≈ H+6 | B1, B2, F0, F1 | Player · Join / Ready on two real phones (iOS Safari + Android Chrome) against the **real** server through the Vercel UI: `WELCOME`, sync numbers (`status.syncErrMs`, `rttMs`), `AUDIO_READY`, `health good`; `/diag` screenshots in `evidence/frontend/` |
| **IC2** | ≈ H+11 | B3, B4, F2, F3 | Three phones in unison from the host phone: Lobby → `SET_TRACK` → Start; the rig measures device-to-device skew <10 ms; a +40 ms nudge from the player sheet moves one phone by 40±3 ms; lock and unlock a phone and it is back in sync within 5 s |
| **IC3** | ≈ H+15 | B5, B6, F4, F5, F6 | ORCHESTRA plus at least one more mode from the chips with no reload; Hive Map placement (drag, tap-to-cycle) recolours dots and changes what plays; a vibe plan renders on the strip and the phones switch mode at the boundary together |
| **Rehearsal** | ≈ H+17 | B7, B8, F7, F8, F9 | The full three-minute script below on ≥6 phones on the venue Wi-Fi, including the Tier 2 tuning moment on the host phone, twice in a row without a restart; video in `evidence/frontend/`; cut-list decisions recorded in the status table |

## Status table

Each agent edits its own rows only (the detailed gate tables with ✅/🟡 live in `agents/<AGENT>-AGENT.md`). Status ∈ `todo` · `doing` · `done` · `needs human` · `cut`. Evidence is a path under `evidence/<agent>/`.

| Gate | Owner | Status | Evidence |
|---|---|---|---|
| B0 | backend | done | `evidence/backend/B0-routes.txt` |
| B1 | backend | done | `evidence/backend/B1-room-test.txt` |
| B2 | backend | done | `evidence/backend/B2-clock-test.txt` |
| B3 | backend | todo | |
| B4 | backend | todo | |
| B5 | backend | todo | |
| B6 | backend | todo | |
| B7 | backend | todo | |
| B8 | backend | todo | |
| B9 (stretch) | backend | todo | |
| F0 | frontend | todo | |
| F1 | frontend | todo | |
| F2 | frontend | todo | |
| F3 | frontend | todo | |
| F4 | frontend | todo | |
| F5 | frontend | todo | |
| F6 | frontend | todo | |
| F7 | frontend | todo | |
| F8 | frontend | todo | |
| F9 | frontend | todo | |

## Cut list

Apply in this order — at rehearsal, or earlier if a checkpoint slips by more than an hour. Record each cut in the status table.

1. **B9** — upload path, crowd-sourced table, `playbackRate` slewing.
2. **Drag-to-reassign polish** — keep drag → `SET_POSITION` and tap-to-cycle → `ASSIGN`; drop animations, snapping, multi-select.
3. **B8 / F7 — Tier 2 calibration** — keep Tier 1 (table + nudge); the tuning moment becomes the host nudging one phone live from the player sheet.
4. **STROBE** — remove the chip; WAVE stays as the finale.
5. **Vibe LLM call** — keep the rules fallback; the prompt box still works, it just never calls Claude (`source: 'rules'`).
6. **STEREO** — remove the chip; ORCHESTRA covers "stems on different phones".

Never cut: UNISON on ≥3 phones, QR join, the host phone as host, the Hive Map dots, restart recovery.

## Three-minute demo script

Setup: every phone on one Wi-Fi/hotspot; screens at full brightness; iOS ringer switches on; the host phone mirrored to the room screen; the room `BZQ7` (`ROOM_FIXED_CODE`) pre-created so the printed QR is valid before the talk starts; `synthetic-60s` (120 BPM, drop at 30 s) or the demo track selected in the Lobby.

| Time | Beat | On screen / in the room | Under the hood |
|---|---|---|---|
| 0:00 | "Every phone is a speaker" | Host phone: Host a hive → Lobby with code `BZQ7`, a big QR, the track picked | `POST /rooms {code:'BZQ7'}` → `joinUrl`; `JOIN` (host, `plays:false`); `SET_TRACK` |
| 0:15 | Six phones join | Players scan, type a name, tap to join; the lobby count climbs 1 → 6; progress bars fill; "Synced ±N ms"; Start lights up when every phone has `audioReadyTrackId` | `JOIN`, NTP burst, stem downloads, `AUDIO_READY`, `CLIENT_STATUS` → `HEALTH` |
| 0:45 | Unison | Host presses Start: the room is suddenly ~8 dB louder than any single phone; player screens go white and pulse on the beat | `TRANSPORT PLAY` → `ROOM_STATE` with `transport`; every phone schedules from `serverTimeAtTrackZero` |
| 1:05 | The tuning moment | Host pauses, taps Tune the hive → "Quiet, please." → 3 s countdown → phones raised near the host → six clicks in 2.4 s → rows fill with residuals and confidence → Apply offsets → play; the unison audibly tightens | `TRANSPORT PAUSE`, `CALIBRATION_START`, `CALIBRATION_PLAN`, 6× `SCHEDULED_ACTION CALIBRATION_CLICK`, `CALIBRATION_REPORT`, re-plan, `TRANSPORT PLAY` |
| 1:35 | Orchestra | Host taps Orchestra: phones recolour amber / violet / cyan / green; the host walks the room — drums here, vocals there — and drags two dots on the map, pins one part | `SET_MODE ORCHESTRA`, `SET_POSITION` (10 Hz), `ASSIGN` |
| 2:05 | Vibe prompt | Host types "calm, then explode at the drop" and taps Direct; the scene strip shows UNISON → WAVE/STROBE at the drop; the room waits for it | `POST /rooms/BZQ7/vibe`, `ROOM_STATE` with `scenePlan`, scene timer armed |
| 2:30 | Wave / strobe finale | The drop hits: the beat and a slow swell sweep wall to wall (WAVE), then screens and sound strobe in coloured groups (STROBE) — on the shared clock with zero per-tick traffic | assignments with `applyAtServerTime`; `evaluatePattern` client-side |
| 2:55 | Close | Host pauses; one line of physics: "+10 dB from ten phones, fusion under 10 ms, and no laptop anywhere" | `TRANSPORT PAUSE` |

If Tier 2 is cut, 1:05 becomes: the host opens one player's sheet and drags the nudge slider while the room listens until the phone snaps into place. If the LLM call is cut, 2:05 is identical on screen — the rules fallback produces the same two-scene plan for that prompt. The seek at 2:30 is a `TRANSPORT SEEK` to a few seconds before `dropSec` if the talk runs long.

## Checkpoint procedure

Same seven steps at IC1, IC2, IC3 and the rehearsal; budget 30 minutes.

1. Both agents: `git fetch origin main && git rebase origin/main` on their own branch; resolve nothing outside their own tree (only `PROTOCOL-REQUESTS.md` and the status table can conflict — keep both sides).
2. Both: `bun run typecheck && bun run test` green locally.
3. Both: open a PR to `main`; CI must be green. The human merges.
4. Backend merges first (it may bump `PROTOCOL_VERSION` and the mock), then frontend after a rebase on the merged `main`.
5. Deploy: backend `fly deploy` from `main`; Vercel builds `main` automatically.
6. Joint check from the table above, on real phones, using the deployed URLs.
7. Both update their rows in the status table and drop evidence files; the checkpoint is done only when the joint check passes.

## Evidence conventions

`evidence/<agent>/<gate>-<short>.{png,md,txt,mp4}` (from `evidence/README.md`); `.mp4` and `.wav` are gitignored, so a one-line `.md` names the recording and its measurement.

| Kind | Example |
|---|---|
| Runnable check output | `evidence/backend/B2-clock-model.txt` |
| Screenshot | `evidence/frontend/F1-diag-ios-safari.png` |
| Rig report (+ `.md` naming the gitignored WAV) | `evidence/backend/B4-rig-t5min.txt`, `evidence/backend/B4-rig-t5min.md` |
| Video (gitignored) + `.md` note | `evidence/frontend/F8-e2e-3-phones.mp4`, `evidence/frontend/F8-e2e-3-phones.md` |
| Manual checklist | `evidence/frontend/F1-checklist.md` |

Evidence names the gate; the status table links to it. No gate is `done` without a file; a gate whose check needs hardware or a person the agent does not have is `needs human` with the manual checklist filled in.

## Risk register

| Risk | Trigger | Mitigation | Owner |
|---|---|---|---|
| Wi-Fi at the venue is asymmetric or lossy | `syncErrMs` warn/bad on most phones | bring a phone hotspot; every phone on it; the server is still in the cloud | both |
| iOS silent switch mutes players | player shows ready but no sound | `navigator.audioSession.type='playback'` in `audio.unlock()` + the ringer banner on Player · Join | backend (engine), frontend (banner) |
| Android output latency far from the table row | one family consistently early/late | Tier 2 fixes it; else nudge; else correct `STARTER_LATENCY_TABLE_MS` from the rig | backend |
| Fly restarts mid-demo | reconnect banner on every phone | in-memory rooms are re-created from `ROOM_FIXED_CODE`; clients rejoin by `clientId` within 5 s; the host re-selects the track and presses Play | backend |
| No Anthropic key or credit | vibe returns `source: 'rules'` | the rules fallback produces the same two-scene plan for the demo prompt | backend |
| Clock spikes on join burst (20 phones at once) | B1 20-join test | min-RTT + coded pairs reject queued probes; NTP answered outside the coalescer | backend |
| Stem download slow on 20 phones | progress bars stall | cache headers; ≤60 s clips; start the join phase 5 minutes before the talk | both |
| A phone locks during the show | that phone drops out | Wake Lock; on unlock the drift check resyncs; the "Tap to resume" state is one tap | frontend |
| Protocol drift between branches | typecheck fails on rebase | additive-only rule; `PROTOCOL-REQUESTS.md`; mock updated in the same commit | backend |

## Demo-day checklist (T−30 min)

- [ ] Fly `/health` 200; Vercel `main` deployed; both URLs open on the host phone over HTTPS.
- [ ] Room `BZQ7` exists (`POST /rooms {code:'BZQ7'}`); QR printed and on the first slide; `joinUrl` points at the Vercel origin.
- [ ] Hotspot up; every phone joined to it; cellular data off on the demo phones.
- [ ] Host phone: mirroring works; battery >50 %; Do Not Disturb on.
- [ ] Player phones: ringer on, brightness max, auto-lock off as a backup to Wake Lock, browser tabs closed except the join page.
- [ ] `synthetic-60s` and the demo track appear in `GET /tracks?q=`; stems download in <20 s on the hotspot.
- [ ] One dry run of the full script; Tier 2 residuals within ±5 ms on every phone, or the Tier 1 fallback beat is rehearsed instead.
- [ ] `ANTHROPIC_API_KEY` set on Fly and one vibe call returns `source: 'llm'` — or the fallback is confirmed to produce the two-scene plan for "calm, then explode at the drop".

## Related

- [00-context.md](00-context.md#canonical-numbers) — the numbers every gate check uses
- [01-architecture.md](01-architecture.md#ownership-matrix) — who may touch which directory
- [PROTOCOL-REQUESTS.md](PROTOCOL-REQUESTS.md) — how to ask for a contract change without blocking a gate
- `agents/SHARED-RULES.md`, `agents/BACKEND-AGENT.md`, `agents/FRONTEND-AGENT.md` — rules and full gate definitions with checks and evidence files
