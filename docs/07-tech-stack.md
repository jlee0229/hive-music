# HiveMusic — Tech Stack

Owner: both

A fresh Turborepo in Beatsync's shape: Bun on the server side, Next.js on Vercel for the UI, zod schemas as the single contract, and no dependency that could fail on stage. The hard rules are in `agents/SHARED-RULES.md`; this doc is the "which tool, why, how configured" reference.

## Stack

| Layer | Choice | Version / note |
|---|---|---|
| Runtime + package manager | Bun | ≥ 1.2; `bun install`, `bun test`, `bun run` |
| Monorepo | Turborepo | tasks `typecheck`, `test`, `build`, `dev`, `lint`; root `bun run typecheck && bun test` must be green before any merge |
| Language | TypeScript | `strict: true` (plus `noUncheckedIndexedAccess` — assumption) via a shared `tsconfig.base.json` |
| Schemas | zod | discriminated unions for every message; `ScenePlanSchema` doubles as the structured-output format |
| Server | `Bun.serve` | HTTP + WebSocket in one process; `ws.subscribe('room:<code>')` and `server.publish(topic, data)` for fan-out |
| Web | Next.js 15 app router + Tailwind | routes `/`, `/h/[code]`, `/j/[code]`, `/diag`; dark stage theme; big touch targets |
| Unit tests | `bun test` | protocol schema + planner tests; clock model with a fake transport; calibration xcorr on synthetic recordings |
| Web tests | Playwright | against the mock server (`bun run mock --scenario …`) |
| LLM | `@anthropic-ai/sdk` | `client.messages.parse` + `zodOutputFormat`; model from `VIBE_MODEL` |
| QR | `qrcode` | Host · Lobby renders `${location.origin}/j/${code}` to a canvas/SVG |
| Screen | Wake Lock API | `navigator.wakeLock.request('screen')` in `apps/web` after unlock; HTTPS required |
| Audio | Web Audio API | one `AudioContext` per page, owned by `@hive/sync-client`; `navigator.audioSession.type = 'playback'` when available |
| Hosting | Fly.io (server) + Vercel (web) | one always-on machine in `bos` |

## Repository layout

```
hive-music/
├── apps/server/          Bun.serve: WS + REST + /audio                       (backend)
├── apps/web/             Next.js 15; mocks/scenarios/{party-12,calibrating,restart}.json   (frontend)
├── packages/protocol/    @hive/protocol: messages, room, assignment, constants, planner, pattern, health, scene, mock-server
├── packages/sync-client/ @hive/sync-client: createHiveClient, calibration/xcorr, rig/
├── fixtures/             gen-synthetic.ts, synthetic-60s/*.wav + meta.json, demo tracks
├── infra/                fly.toml, Dockerfile
├── evidence/{backend,frontend}/
├── agents/               SHARED-RULES, BACKEND-AGENT, FRONTEND-AGENT
├── .github/workflows/ci.yml   bun install → typecheck → test, per package
└── docs/                 this folder
```

## Environment variables

`.env.example` at the root; copy to `.env` for the server and to `apps/web/.env.local` for the web app:

```
# apps/web (Vercel project env)
NEXT_PUBLIC_API_URL=https://<app>.fly.dev          # REST base; mock: http://localhost:8080
NEXT_PUBLIC_WS_URL=wss://<app>.fly.dev/ws          # WebSocket; mock: ws://localhost:8080/ws

# apps/server (Fly secrets / local .env)
PORT=8080
VIBE_MODEL=claude-sonnet-5                         # any Claude model id; see 05-effect-modes.md
ANTHROPIC_API_KEY=                                 # empty → rules fallback
REPLICATE_API_TOKEN=                               # B9 upload path only
ROOM_FIXED_CODE=HIVE                               # POST /rooms {code} with this code returns the demo room
```

(assumption) `ROOM_FIXED_CODE`: when set, `POST /rooms {code: ROOM_FIXED_CODE}` returns that room (creating it if needed) and its `hostKey`, so the printed QR and the host's bookmark survive a server restart. Any other requested `code` is rejected with 400; with no `code`, a random 4-letter code is issued. The WebSocket path `/ws` and the default port 8080 are assumptions; [02-protocol.md](02-protocol.md) is authoritative. The mock server listens on the same `PORT` default so `apps/web/.env.local` is identical for mock and real.

## Bun server pattern

```ts
type Conn = { clientId: string | null; roomCode: string | null };

const server = Bun.serve<Conn>({
  port: Number(process.env.PORT ?? 8080),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return server.upgrade(req, { data: { clientId: null, roomCode: null } })
        ? undefined
        : new Response('upgrade failed', { status: 400 });
    }
    return withCors(route(req, url));   // /health, /rooms, /rooms/:code, /tracks?q=, /audio/:trackId/:stem.wav, /rooms/:code/vibe
  },
  websocket: {
    message(ws, raw) {
      const parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) return send(ws, { type: 'ERROR', code: 'BAD_MESSAGE' });
      handle(ws, parsed.data);          // JOIN → ws.subscribe(`room:${code}`) (+ `hosts:${code}` for hosts)
    },
    close(ws) { markDisconnected(ws.data); },   // record kept 120 s
  },
});

// fan-out
server.publish(`room:${code}`,  JSON.stringify({ type: 'ROOM_STATE', room }));   // ≤2 Hz, coalesced
server.publish(`hosts:${code}`, JSON.stringify({ type: 'HEALTH', clients }));   // 1 Hz
```

Coalescing: any room mutation marks the room dirty; a 500 ms timer publishes at most one `ROOM_STATE` per tick (≤2 Hz). Heartbeat: the server sends `PING` every 20 s, the client answers `PONG`; a socket with no `PONG` for 45 s (assumption) is closed and the client reconnects. This keeps Fly's proxy from idling the connection. `NTP_REQUEST` bypasses coalescing and is answered immediately with `t1` stamped on receipt and `t2` on send.

## CORS

`/audio/*`, `/rooms/*`, `/tracks`, `/health` respond with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, and answer `OPTIONS` with 204. `/audio` also sends `Content-Type: audio/wav`, `Accept-Ranges: bytes`, and `Cache-Control: public, max-age=31536000, immutable` (track ids are content-stable), so a reload does not re-download 40 MB of stems. WebSocket upgrades are not subject to CORS and the server does not check `Origin` (demo).

## Fly.io (`infra/fly.toml`)

```toml
app = "hive-music-server"            # (assumption on the name)
primary_region = "bos"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false         # never scale to zero mid-demo
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "connections"
    soft_limit = 800
    hard_limit = 1000

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

`infra/Dockerfile`: `oven/bun:1` base; copies the repo (root `.dockerignore` drops `node_modules`, `.git`, `evidence`, `.next`, generated WAVs); `bun install` (the lockfile is committed); `bun run fixtures` regenerates the WAVs in the image; `CMD ["bun", "apps/server/src/index.ts"]`. Deploy from the repo root with `fly launch --copy-config --dockerfile infra/Dockerfile` (then `fly deploy`); secrets via `fly secrets set ANTHROPIC_API_KEY=… VIBE_MODEL=… ROOM_FIXED_CODE=…`. **One machine only** — rooms live in memory and a second machine would split a room. Gate B7: `/health` returns 200 over HTTPS; a phone joins and syncs over WSS. The stub is deployed right after B0 (cloud from hour one); B7 is the hardening pass.

## Vercel (`apps/web`)

Project root directory `apps/web`; framework Next.js; install command `bun install` at the repo root with "include files outside the root directory" enabled so the workspace packages resolve; build `next build`. Env: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`. Preview deployments per branch give the frontend agent a phone-testable HTTPS URL on every push (assumption on Vercel settings).

## Ported from Beatsync vs written fresh

| Ported (math and ideas, re-typed by hand) | Written fresh |
|---|---|
| NTP math from `apps/client/src/utils/ntp.ts`: `t0..t3`, `offset = ((t1−t0)+(t2−t3))/2`, `rtt = (t3−t0)−(t2−t1)`, min-RTT selection | Transport-derived scheduling (`serverTimeAtTrackZero`) instead of scheduled PLAY/PAUSE |
| Coded probe pairs: reject pairs whose server inter-arrival gap ≠ client inter-departure gap | Stem preload, gain-ramp modes, planner, `evaluatePattern` |
| The `SCHEDULED_ACTION` idea (kept only for `CALIBRATION_CLICK`) | Calibration: Tier 1 table/nudge, Tier 2 host-phone listener, xcorr rig |
| zod discriminated-union message style (`WSRequest` / `WSBroadcast` / `WSUnicast` → our `messages.ts`) | Room/health/identity model, 120 s retention, fixed code, `plays` toggle |
| Turborepo + Bun + Next.js + Tailwind shape | Vibe Director: Claude structured output + rules fallback + scene timer |
| — | Hive Map, host/player screens, `/diag` |

Not forked because Beatsync's server needs Cloudflare R2, a music provider, chat and backups — none of which we want to carry to a stage.

## Why WAV

Stems are mono 16-bit WAV, ≤4 per track, ≤60 s (≈42 MB decoded per phone as Float32). MP3/AAC decoder priming differs per browser by up to ~25 ms — larger than the entire ≤10 ms target — and would have to be measured per browser family on top of output latency. WAV decodes to sample-exact buffers everywhere; the extra download (≈5 MB per stem at 44.1 kHz) happens once, before playback, behind the progress bar, and is served immutable so reloads are free.

## Why no service worker

The PWA has a `manifest.webmanifest` (name, icons, `display: standalone`, dark theme colour) so "Add to Home Screen" works and the app looks native, but no service worker: a cached stale bundle or a cached stem during a live demo is the one failure we could not fix from the stage. Stems are cached by the HTTP headers above instead; the app itself is always the latest Vercel deploy.

## Mock server

`bun run mock --scenario apps/web/mocks/scenarios/party-12.json` starts `@hive/protocol`'s mock on `PORT` (default 8080): the same REST routes, the same message schemas, the same `plan(room)`, fixtures served on the real `/audio` routes, and scripted scenarios — `party-12` (12 players, mixed health), `calibrating` (a `CALIBRATION_PLAN`/`CLICK` sequence with progress), `restart` (drops every socket after 10 s and comes back, exercising the reconnect banner). The frontend builds and tests against it until F8; Playwright runs against it in CI.

## CI

`.github/workflows/ci.yml`: `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`, per package via Turborepo. Required on PRs to `main`; both agent branches rebase on `main` before each gate.
