# HiveMusic — Tech Stack

Owner: both

A fresh Turborepo in Beatsync's shape: Bun on the server side, Next.js on Vercel for the UI, zod schemas as the single contract, and no dependency that could fail on stage. The hard rules are in `agents/SHARED-RULES.md`; this doc is the "which tool, why, how configured" reference. Where the repo already pins something (`package.json`, `.env.example`, `infra/`, `.github/`), the repo wins.

## Stack

| Layer | Choice | Version / note |
|---|---|---|
| Runtime + package manager | Bun | ≥ 1.2 required; the repo pins `bun@1.3.11` (`packageManager`, CI); hoisted linker in `bunfig.toml` |
| Monorepo | Turborepo 2 | tasks `build`, `typecheck`, `test`, `lint`, `dev` (`turbo.json`); root scripts `bun run typecheck && bun run test` must be green before any merge |
| Language | TypeScript 5.6 | `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `moduleResolution: bundler`, `types: ["bun-types"]`, `noEmit` |
| Schemas | zod 3 | discriminated unions for every message; `ScenePlanCoreSchema` doubles as the structured-output format |
| Server | `Bun.serve` | HTTP + WebSocket in one process; `ws.subscribe(room.code)` and `server.publish(room.code, data)` for fan-out |
| Web | Next.js 15 app router + Tailwind v4 | routes `/`, `/h/[code]`, `/j/[code]`, `/diag`; tokens from [06](06-hive-map-ui.md) in `app/globals.css`; `public/manifest.webmanifest` |
| Unit tests | `bun test` (per package via turbo) | protocol schema/planner/pattern/mock tests; `ClockModel` with a fake transport; xcorr on synthetic recordings |
| Web tests | Playwright | against the mock server (`bun run mock --scenario …`) and `createStubClient` |
| LLM | `@anthropic-ai/sdk` | `client.messages.parse` + `zodOutputFormat`; model from `VIBE_MODEL` |
| QR | `qrcode` | Host · Lobby renders `joinUrl` from `POST /rooms` to a canvas/SVG |
| Screen | Wake Lock API | requested inside `audio.unlock()` by the engine; `/diag` shows its state; HTTPS required |
| Audio | Web Audio API | one `AudioContext` per page, owned by `@hive/sync-client`; `navigator.audioSession.type = 'playback'` when available |
| Hosting | Fly.io (server) + Vercel (web) | one always-on machine in `ewr` (Newark; Fly retired `bos`) |

## Repository layout

```
hive-music/
├── apps/server/           Bun.serve: WS + REST + /audio                                   (backend)
├── apps/web/              Next.js 15; app/, public/manifest.webmanifest, mocks/scenarios/ (frontend)
├── packages/protocol/     @hive/protocol: constants, messages, room, mode, pattern, health, scene, rest, planner, mock-server, __tests__
├── packages/sync-client/  @hive/sync-client: index.ts (frozen API), stub.ts, calibration/, rig/
├── fixtures/              gen-synthetic.ts, README.md, tracks/<id>/{stems}.wav (gitignored) + meta.json
├── infra/                 fly.toml, Dockerfile
├── evidence/{backend,frontend}/
├── agents/                SHARED-RULES, BACKEND-AGENT, FRONTEND-AGENT
├── .github/workflows/ci.yml   bun install → bun run fixtures → typecheck → test
└── docs/                  this folder
```

## Commands

```
bun install                                   # once
bun run fixtures                              # writes fixtures/tracks/synthetic-60s/*.wav + meta.json
bun run typecheck && bun run test             # root gate (turbo runs every package)
bun run mock --scenario apps/web/mocks/scenarios/party-12.json   # mock on :8080, ws://localhost:8080/ws
bun run --cwd apps/server dev                 # real server on :8080 (backend)
bun run --cwd apps/web dev                    # Next.js on :3000 (frontend)
bun run --cwd packages/protocol test          # one package
```

Use `bun run --cwd <dir> <script>`; `bun --cwd <dir> run` does not run scripts.

## Environment variables

`.env.example` at the root; copy to `.env` for the server and to `apps/web/.env.local` for the web app:

```
# apps/web (NEXT_PUBLIC_* is baked into the browser bundle)
NEXT_PUBLIC_API_URL=http://localhost:8080          # REST base; production: https://hivemusic-server.fly.dev
NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws          # WebSocket; production: wss://hivemusic-server.fly.dev/ws

# apps/server
PORT=8080                                          # Bun.serve port (Fly sets 8080 via fly.toml)
VIBE_MODEL=claude-sonnet-5                         # Claude model for the Vibe Director
ANTHROPIC_API_KEY=                                 # empty → rules fallback
REPLICATE_API_TOKEN=                               # B9 upload path only
ROOM_FIXED_CODE=BZQ7                               # POST /rooms {code} with this code returns the demo room
CORS_ORIGIN=http://localhost:3000                  # browser origin allowed on /health, /rooms, /tracks, /audio
```

`ROOM_FIXED_CODE`: `POST /rooms {code: ROOM_FIXED_CODE}` returns that room (creating it if needed) and its `hostKey`, so the printed QR and the host's bookmark survive a server restart. The mock's room code is the scenario's `roomCode` (`BZQ7` in every shipped scenario). `joinUrl` in the `POST /rooms` response is built from `NEXT_PUBLIC_WEB_URL` (default `http://localhost:3000`) — set it on Fly to the Vercel origin (assumption for the real server; the mock already reads it). Without `code`, a random 4-character code from `ROOM_CODE_ALPHABET` is issued; a non-fixed requested code is rejected (assumption).

## Bun server pattern

```ts
type Conn = { clientId: string | null };

const server = Bun.serve<Conn>({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req, srv) {
    const url = new URL(req.url);
    const cors = { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN ?? '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/ws') return srv.upgrade(req, { data: { clientId: null } }) ? undefined : new Response('upgrade failed', { status: 400 });
    return route(req, url, cors);   // /health, /rooms, /rooms/:code, /tracks?q=, /audio/:trackId/:stem.wav, /rooms/:code/vibe
  },
  websocket: {
    open(ws) { /* subscribe on JOIN, once the room is known */ },
    message(ws, raw) {
      const msg = parseClientMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      if (!msg) return send(ws, { type: 'ERROR', code: 'BAD_MESSAGE', message: 'message failed schema validation' });
      handle(ws, msg);              // JOIN → ws.subscribe(room.code), WELCOME, replan, flush
    },
    close(ws) { markDisconnected(ws.data.clientId); },   // record kept DISCONNECT_RETENTION_MS
  },
});

server.publish(room.code, JSON.stringify({ type: 'ROOM_STATE', room }));            // ≤2 Hz via a dirty flag + flush timer
for (const id of room.hostClientIds) send(sockets.get(id), { type: 'HEALTH', serverTime, clients });   // 1 Hz, hosts only
server.publish(room.code, JSON.stringify({ type: 'PING', serverTime }));            // every PING_INTERVAL_MS = 20 s
```

This is the shape of `packages/protocol/src/mock-server.ts`; the real server reuses it with real rooms, timers and the vibe service. Coalescing: any mutation sets `dirty`; a `1000 / ROOM_STATE_MAX_HZ` timer publishes at most one snapshot per tick, and a joiner gets one immediately. `NTP_REQUEST` is answered synchronously with `t1` stamped on receipt and `t2` on send. A socket that misses two `PING`s without a `PONG` (45 s, assumption) is closed and the client reconnects.

## CORS

Every REST route answers with `Access-Control-Allow-Origin: CORS_ORIGIN` (the Vercel origin in production; `*` when unset), `Access-Control-Allow-Methods: GET,POST,OPTIONS`, `Access-Control-Allow-Headers: content-type`, and `OPTIONS` → 204. `/audio` also sends `Content-Type: audio/wav` and `Cache-Control: public` (the mock uses `max-age=3600`; the real server may use a long immutable cache because track ids are content-stable — assumption), so a reload does not re-download 40 MB of stems. WebSocket upgrades are not subject to CORS and the server does not check `Origin` (demo).

## Fly.io (`fly.toml` (repo root; `dockerfile = "infra/Dockerfile"`), `infra/Dockerfile`)

```toml
app = "hivemusic-server"
primary_region = "bos"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false        # never scale to zero mid-demo
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "15s"
    timeout = "5s"
    grace_period = "10s"
```

`Dockerfile`: `FROM oven/bun:1`, `COPY . .`, `bun install`, `bun run fixtures` (the synthetic track is generated in the image), `CMD ["bun", "apps/server/src/index.ts"]`, `EXPOSE 8080`. Deploy from the repo root with `fly launch --copy-config --dockerfile infra/Dockerfile` (first time) and `fly deploy` afterwards; secrets via `fly secrets set ANTHROPIC_API_KEY=… VIBE_MODEL=claude-sonnet-5 ROOM_FIXED_CODE=BZQ7 CORS_ORIGIN=https://<web>.vercel.app NEXT_PUBLIC_WEB_URL=https://<web>.vercel.app`. **One machine only** — rooms live in memory and a second machine would split a room. The app-level `PING` every 20 s keeps Fly's proxy from idling the socket. Gate B7: `/health` returns `{ok, protocolVersion, serverTime}` over HTTPS; a phone joins and syncs over WSS. The stub is deployed right after B0 (cloud from hour one); B7 is the hardening pass.

## Vercel (`apps/web`)

Project root directory `apps/web`; framework Next.js; install command `bun install` at the repo root with "include files outside the root directory" enabled so the workspace packages resolve; build `next build`. Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`. Preview deployments per branch give the frontend agent a phone-testable HTTPS URL on every push (assumption on Vercel settings).

## Ported from Beatsync vs written fresh

| Ported (math and ideas, re-typed by hand) | Written fresh |
|---|---|
| NTP math from `apps/client/src/utils/ntp.ts`: `t0..t3`, `offset = ((t1−t0)+(t2−t3))/2`, `rtt = (t3−t0)−(t2−t1)`, min-RTT selection over a window (`ClockModel`) | Transport-derived scheduling (`serverTimeAtTrackZero`) instead of scheduled PLAY/PAUSE |
| Coded probe pairs: reject pairs whose server inter-arrival gap ≠ client inter-departure gap | Stem preload, gain-ramp modes, planner, `evaluatePattern` |
| The `SCHEDULED_ACTION` idea (kept only for `CALIBRATION_CLICK`) | Calibration: Tier 1 table/nudge, Tier 2 host-phone listener, xcorr rig |
| zod discriminated-union message style (`WSRequest` / `WSBroadcast` / `WSUnicast` → our `ClientMessageSchema` / `ServerMessageSchema`) | Room/health/identity model, 120 s retention, fixed code, `plays` toggle, `KICK` |
| Turborepo + Bun + Next.js + Tailwind shape | Vibe Director: Claude structured output + rules fallback + scene timer |
| — | Hive Map, host/player screens, `/diag`, mock scenarios |

Not forked because Beatsync's server needs Cloudflare R2, a music provider, chat and backups — none of which we want to carry to a stage.

## Why WAV

Stems are mono 16-bit WAV at 44.1 kHz, ≤4 per track, ≤60 s (≈42 MB decoded per phone as Float32; see `fixtures/README.md`). MP3/AAC decoder priming differs per browser by up to ~25 ms — larger than the entire ≤10 ms target — and would have to be measured per browser family on top of output latency. WAV decodes to sample-exact buffers everywhere; the extra download (≈5 MB per stem) happens once, before playback, behind the progress bar, and is cached by the HTTP headers above.

## Why no service worker

The PWA has `public/manifest.webmanifest` (name, icons, `display: standalone`, dark theme colour) so "Add to Home Screen" works and the app looks native, but no service worker: a cached stale bundle or a cached stem during a live demo is the one failure we could not fix from the stage. Stems are cached by HTTP headers instead; the app itself is always the latest Vercel deploy, and `WELCOME.protocolVersion` lets a stale tab detect itself and reload.

## Mock server and scenarios

`bun run mock --scenario <file>` starts `packages/protocol/src/mock-server.ts` on `PORT` (default 8080, WebSocket at `/ws`): the same REST routes, the same message schemas, the same `plan(room)`, fixtures served from `fixtures/tracks` on the real `/audio` routes, a simulated tuning moment (countdown → running → fake residuals for mock players), a rules-only `/vibe`, and optional chaos. Scenarios are frontend-owned JSON (`roomCode`, `trackId`, `mode`, `transport`, `players[]` with `browserFamily`/`position`/`health`/`pinnedRole`, `calibration`, `scenePlan`, `chaos`):

| Scenario | Contents | Exercises |
|---|---|---|
| `party-12.json` | 12 players, ORCHESTRA, playing, one pinned role, mixed health, an unplaced phone, a 3-scene plan | Stage, Hive Map, legend, scene strip (F2, F4, F5, F6) |
| `calibrating.json` | 6 players, UNISON, stopped, `calibration.state: running` with 2 results | Host · Calibrate rows, Player · Calibrating (F7) |
| `restart.json` | 6 players, playing, `chaos.restartAfterSec: 20` — every socket dropped after 20 s | reconnect banner, recovery within 5 s (F1, F9) |

The frontend builds and tests against the mock until F8; Playwright runs against it in CI.

## CI

`.github/workflows/ci.yml` on every push and PR: `oven-sh/setup-bun@v2` (1.3.11) → `bun install` → `bun run fixtures` → `bun run typecheck` → `bun run test`. Required on PRs to `main`; both agent branches rebase on `main` before each gate.
