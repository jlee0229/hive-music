# Server agent brief — room server, vibe director, infra

**Model:** Claude Sonnet 5. **Branch:** `agent/server`. **Rules:** [SHARED-RULES.md](SHARED-RULES.md) apply in full.

## Mission

Ship the room server that every phone talks to, fast, so the first real phone test can happen within hours. Your work is a
port of the working mock server (`packages/protocol/src/mock-server.ts`) into `apps/server`, with the fakes replaced by real
behaviour. The **engine agent** (Opus 5, branch `agent/backend`) owns the browser audio engine and the contract; the
**frontend agent** (Sonnet 5, branch `agent/frontend`) builds the UI against the mock and switches to your server at IC1.
The human deploys your server to Fly.io from `main` (a GitHub Action does it on every merge); you keep it deployable.

## Read first (~15 minutes)

1. [SHARED-RULES.md](SHARED-RULES.md)
2. [docs/02-protocol.md](../docs/02-protocol.md) — the contract; the mock server is the reference implementation of every handler
3. `packages/protocol/src/mock-server.ts`, `planner.ts`, `scene.ts`, `constants.ts`
4. [docs/01-architecture.md](../docs/01-architecture.md) §data flows, [docs/05-effect-modes.md](../docs/05-effect-modes.md) §Vibe Director, [docs/07-tech-stack.md](../docs/07-tech-stack.md), [docs/09-deploy.md](../docs/09-deploy.md)
5. Run `bun install && bun run fixtures && bun run typecheck && bun run test` before touching anything.

## You own / you never touch

Own: `apps/server/**`, `infra/**`, `fly.toml`, `fixtures/**`, `evidence/server/**`, this file's gate table, your rows in `docs/08-roadmap.md`.
Never: `apps/web/**`, `packages/**` (the engine agent owns the contract; ask in `docs/PROTOCOL-REQUESTS.md`).

## Engineering notes

- Copy the mock's structure: `Bun.serve` with `websocket` handlers, `ws.subscribe(code)` / `server.publish(code, …)`, a dirty flag
  flushed at `ROOM_STATE_MAX_HZ`, `HEALTH` to `hostClientIds` at `HEALTH_HZ`, `PING` every `PING_INTERVAL_MS`. Rooms are in-memory
  `Map<code, Room>`; one Fly machine only.
- Server time = `performance.timeOrigin + performance.now()`; `NTP_RESPONSE` stamps `t1` on receive and `t2` right before send.
- `JOIN` with a known `clientId` restores the record (`joinIndex`, position, pins, nudge, calibration, assignment); disconnected records
  live `DISCONNECT_RETENTION_MS`; rooms die `ROOM_IDLE_TTL_MS` after the last client leaves. `ROOM_FIXED_CODE` makes `POST /rooms`
  return the same room (create on first call) so the printed QR survives a restart. Host = `kind:'host'` with the right `hostKey`.
- Timeline: `PLAY/SEEK` → `serverTimeAtTrackZero = now + LEAD_MS − trackTimeSec·1000`; `PAUSE` → `trackTimeAtPause`. Every change
  runs `withAssignments(room, applyAt)`. `SET_MODE` clears `scenePlan`.
- Scene timer: for the active plan, `LEAD_MS` before each boundary set `mode`, re-plan with `applyAtServerTime = boundary`, flush.
- Vibe: `apps/server/src/vibe/rules.ts` first (keyword table + `meta.dropSec` or the energy heuristic in docs/05), then
  `director.ts` with `@anthropic-ai/sdk` `messages.parse` + `zodOutputFormat(ScenePlanCoreSchema)` on `process.env.VIBE_MODEL ??
  "claude-sonnet-5"`, `{ timeout: 5_000, maxRetries: 0 }`; any failure → rules. No key → rules, silently.
- Calibration server side: `CALIBRATION_START` → `order` = speakers except the reference → `CALIBRATION_PLAN` to the reference and one
  `SCHEDULED_ACTION CALIBRATION_CLICK` per player at `start + i·CALIBRATION_CLICK_INTERVAL_MS` (`start = now + CALIBRATION_COUNTDOWN_MS`);
  `CALIBRATION_REPORT` → ignore `confidence < 0.5`, `calibratedOffsetMs = (calibratedOffsetMs ?? tableLatencyMs ?? 0) + residualMs`,
  state `done`; mark `failed` if no report by `start + N·interval + 5000`.
- Static audio: `GET /audio/:id/:stem.wav` from `fixtures/tracks`, `Cache-Control: public, max-age=31536000, immutable`; `GET /tracks?q=`
  from `meta.json` files with absolute `urls` built from the request origin.
- CORS on every route: `Access-Control-Allow-Origin: process.env.CORS_ORIGIN ?? "*"`, `OPTIONS` → 204.
- Deploy: `fly.toml` is at the repo root (Fly resolves paths relative to it) with `dockerfile = "infra/Dockerfile"`; the human
  ran `fly launch` once (docs/09-deploy.md) and every merge to `main` deploys via `.github/workflows/deploy-fly.yml`
  (`flyctl deploy --remote-only`). Keep the Dockerfile building: `bun install`, `bun run fixtures`, `bun apps/server/src/index.ts`.

## Ordered tasks and gates (demo-first)

Update the **status** column as you go (⬜ · 🟨 · ✅ · 🟡 needs human · ❌ blocked → request written). Gate ids keep their
original numbers so the roadmap stays readable; the order below is the order you work.

| gate | deliverable | check | evidence | status |
|---|---|---|---|---|
| **B0** | routes: `/health`, `POST /rooms` (fixed code), `GET /rooms/:code`, `GET /tracks?q=`, `GET /audio/:id/:stem.wav`, CORS | curl transcript; root typecheck + test green | `evidence/server/B0-routes.txt` | ✅ |
| **B1** | room manager + WS: JOIN/WELCOME/hostKey, NTP responder, coalesced ROOM_STATE, HEALTH to hosts, PING/PONG, reconnect-by-clientId, retention, SET_TRACK, TRANSPORT, SET_MODE, ASSIGN, SET_POSITION, NUDGE (host or self), SET_PLAYS, KICK, AUDIO_READY, CLIENT_STATUS, planner on every change | `apps/server/src/__tests__/room.test.ts` modelled on the mock's test: 3 fake clients; `t1 ≤ t2`; rejoin keeps `joinIndex`; 20 simultaneous joins < 2 s; player `TRANSPORT` → `NOT_HOST`; PLAY sets `serverTimeAtTrackZero ≈ now + 600` | `evidence/server/B1-room-test.txt` | ✅ |
| **B5s** | scene timer + `applyAtServerTime` at boundaries; `SET_MODE` clears the plan | test: a 3-scene plan on a fake clock re-plans at each boundary with `applyAtServerTime` = boundary | `evidence/server/B5-scenes.txt` | ✅ |
| **B6** | `POST /rooms/:code/vibe`: rules fallback first, then the LLM path behind `ANTHROPIC_API_KEY` | key unset: schema-valid plan, calm first, WAVE/STROBE at `dropSec`; key set (if the human provides one): 10/10 valid on "calm, then explode at the drop" | `evidence/server/B6-vibe.md` | 🟡 needs human (LLM path untested — no `ANTHROPIC_API_KEY`) |
| **B7** | deployable: Dockerfile + `.dockerignore` + root `fly.toml` verified, `docs/09-deploy.md` accurate, `deploy-fly.yml` green on `main`; after the human's first `fly launch`, every merge deploys | `curl https://<app>.fly.dev/health` (human) → 200; you: the workflow file is valid and `bun apps/server/src/index.ts` boots from a clean checkout | `evidence/server/B7-deploy.md` | 🟡 needs human (no Fly credentials, no Docker daemon here) |
| **B8s** | calibration server side (START/PLAN/CLICK/REPORT, accumulation, failed timeout) | test with fake clients: reference gets PLAN, players get one CLICK each on the 400 ms grid, REPORT updates `calibratedOffsetMs`, low-confidence ignored | `evidence/server/B8-calibration.txt` | ✅ |
| **B9** (stretch) | `POST /tracks` upload → Replicate Demucs → `fixtures/meta-from-wavs.ts`; crowd-sourced latency table | after B8s | – | ⬜ |

Merge order: open a PR to `main` as soon as **B1** passes (that is IC1 for the server; the human deploys it), again after B6, again after B8s.

## When to write to `docs/PROTOCOL-REQUESTS.md`

Any time the contract or the mock needs a change (you cannot edit `packages/protocol`): describe the field/message, why, and your
proposed shape; the engine agent answers and bumps the version. Keep building with a local workaround inside `apps/server` only.
