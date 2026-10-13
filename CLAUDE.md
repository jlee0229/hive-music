# HiveMusic — orientation for coding agents

A live product (https://playhivemusic.com): every phone at a party becomes one synchronized speaker.
[`README.md`](README.md) says what it does and how to run it; this file is what an agent needs before changing it.

## Where things are

| path | what | notes |
|---|---|---|
| `packages/protocol` | zod schemas, constants, the pure planner, patterns, health, the mock server | **The wire contract.** A change here is a change to both server and web: bump `PROTOCOL_VERSION`, update `docs/02-protocol.md` and the mock in the same commit, and both halves must be deployed together. |
| `packages/sync-client` | headless browser engine: transport, clock, scheduler, Web Audio, calibration, pitch (CHOIR), stub | `src/index.ts` is its public surface; `apps/web` uses nothing else from it. |
| `apps/server` | Bun WebSocket + REST server: rooms (in memory), timeline, playlist, uploads, tempo analysis, vibe director | imports `@hive/protocol` only |
| `apps/web` | Next.js 15 / React 19 / Tailwind 4: `/`, `/h/[code]` (host stage), `/j/[code]` (player), `/qr/[code]`, `/screen/[code]`, `/diag` | imports only the two packages; never opens its own `WebSocket` or `AudioContext`. No unit tests; covered by `apps/web/e2e`. |
| `fixtures` | synthetic track generator; `fixtures/tracks/` is also where a local server stores uploads | everything there except the two synthetic `meta.json` files is gitignored |
| `infra`, `fly.toml`, `.github` | server image, Fly config, CI | deploys are manual — `docs/13-operations.md` |
| `docs` | design docs + runbook | the README's table says which are current and which are historical |

Current reality, since older docs say otherwise: the repo is `github.com/piar1243/hive-music-official`, default
branch `main`; there is **no lobby screen** (the host lands on the stage), **no fixed room code** (codes are random;
`ROOM_FIXED_CODE`/`BZQ7` survive only in tests, mock scenarios and old docs), no nudge slider, no sync-ms readouts.
`agents/` and `evidence/` are the hackathon's briefs and gate evidence: history, not instructions.

## Commands

Use `bun run --cwd <dir> <script>` (`bun --cwd <dir> run` does not run scripts).

```
bun install                         # after cloning; CI uses --frozen-lockfile
bun run fixtures                    # generate the synthetic WAVs (needed by tests and the dev server)
bun run typecheck                   # all 4 packages
bun run lint                        # web
bun run test                        # unit tests; one package: bun run --cwd packages/protocol test
                                    # one file: cd into the package, then  bun test path/to/file.test.ts
bun run e2e [spec files]            # Playwright vs the mock server + stub engine; starts its own servers
bun run check                       # versions + typecheck + lint + unit + e2e: run before you call work done
bun run --cwd apps/server dev       # server on :8080 (PORT overrides)
bun run --cwd apps/web dev          # web on :3000
bun run mock --scenario apps/web/mocks/scenarios/party-12.json     # scripted fake server on :8080
```

## Rules

- `bun run typecheck && bun run test` green before every commit; the e2e specs you touched too. Never skip,
  delete or loosen a test to get green — if a test is wrong, fix its expectation and say why.
- Timing code uses `performance.now()`, never `Date.now()`. Tunable numbers live in
  `packages/protocol/src/constants.ts`.
- No service worker. No new runtime dependency without a stated reason.
- Never commit audio or `.env*` files. Never copy anything from `fixtures/tracks/` other than the synthetic pair.
- **Never deploy, and never run `flyctl`/`vercel` against production, unless the human asked for exactly that.**
  A server deploy or restart interrupts every party in progress: the music carries on only where the host's
  page is open to put the show back (`docs/13-operations.md` §2.3).
- Product taste: simple, minimal, automatic. Do not add settings, readouts, jargon or explanatory filler to the UI.

## Gotchas that have cost time

- **Playwright runs under node, not bun.** `bun run e2e` already does this
  (`node ../../node_modules/@playwright/test/cli.js test` from `apps/web`). `bun x playwright` fails to spawn the
  browser on Windows.
- **Never run `next build` while `next dev` or the e2e suite is running in `apps/web`** — both write `.next`, and
  the dev cache is corrupted. Stop the dev server first.
- **Port 8080 is often taken** on a dev machine (on the founder's it is a local LLM server). The server reads
  `PORT`; e2e reads `HIVE_MOCK_PORT` and `PW_WEB_PORT` (see the header of `apps/web/playwright.config.ts`).
  Never kill whatever owns 8080 to free it.
- **`NEXT_PUBLIC_*` is baked in when the web server starts.** Process env beats `.env.local`. Restart after changing it.
- **One browser context = one device.** Tabs share `localStorage`, and host and player both key their identity on
  `hive:clientId:<room>`; a join tab steals the host's slot. In Playwright, use a separate browser context per
  simulated device; by hand, a second browser or a private window.
- **The e2e suite rewrites `evidence/frontend/*.png`.** `git checkout -- evidence/frontend` before committing.
- **PowerShell mangles quotes in `git commit -m`.** Write the message to a file and `git commit -F <file>`, or use
  Git Bash for git.
- **Line endings are LF**, enforced by `.gitattributes`; one test reads a file byte-for-byte.
- **Headless Chromium can run the real audio engine** with `--autoplay-policy=no-user-gesture-required` (add
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream` for the microphone). The default e2e run uses
  the stub engine (`NEXT_PUBLIC_HIVE_ENGINE=stub`).
- **Bun is pinned in four places** (`package.json`, `infra/Dockerfile`, both workflows);
  `bun scripts/check-versions.ts` fails when they disagree.
- **Uploads are heavy**: a 10-minute song is a 53 MB WAV and about 280 MB of server memory while it is processed.
