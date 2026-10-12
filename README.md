# HiveMusic

**Every phone in the room. One speaker.** Live at **https://playhivemusic.com**.

A host opens the site and taps **Host a hive**. Friends scan the QR code and join in their browser — nothing to
install. Every phone then plays the same song in tight sync: louder together, and with effects only a crowd of
phones can do.

| mode | what the room hears |
|---|---|
| UNISON | every phone plays the whole song, together |
| ORCHESTRA | each phone plays one part (drums, bass, vocals, other) when the song has stems |
| STEREO | left and right halves of the room |
| WAVE | the sound sweeps across the room |
| STROBE | groups of phones trade off on the beat (the host picks the note length and the number of groups) |
| CHOIR | each phone pitch-shifted to a harmony of the song |

Hosts upload their own songs (decoded in the browser, analysed on the server for energy, drop, tempo and beat
grid); songs rotate as a playlist.

It started as a HackMIT 2026 build in a friend's repo and is now a small live product. The physics, honestly:
phones cannot beam-form, but N phones within ~10 ms of each other are about 10·log₁₀(N) dB louder and fuse into
one source instead of a smear of echoes. The engineering target is ≤ 10 ms device-to-device.
([docs/00-context.md](docs/00-context.md) has the reasoning.)

## How it works

One Bun server owns every room and its timeline; one Next.js app renders the host and player screens; one
headless browser engine does everything clock- and audio-related; one shared package holds the wire contract and
the pure planner that decides what each phone plays.

Phones sync to the server's clock with NTP-style probes over a WebSocket, preload the audio, and schedule playback
against the shared clock on the Web Audio timeline, compensating for each device's output latency. Pressing Start
runs a short automatic acoustic "tuning moment" (the host phone listens to a click from each phone), and playback
is drift-corrected continuously afterwards. A mode change is just a new per-phone assignment (gains, delays, a
pattern) applied at an agreed clock time.

| path | what |
|---|---|
| `packages/protocol` | the contract: zod schemas, constants, the planner (`plan(room)` → per-phone assignment), patterns, health, and a mock server |
| `packages/sync-client` | the browser engine: transport, clock sync, scheduler, Web Audio, calibration, pitch shifting, and an audio-less stub |
| `apps/server` | Bun WebSocket + REST server: rooms, timeline, playlist, uploads, tempo analysis, vibe director |
| `apps/web` | Next.js PWA: landing `/`, host stage `/h/[code]`, player `/j/[code]`, `/qr/[code]`, `/screen/[code]`, `/diag` |
| `fixtures` | generator for two synthetic test tracks; uploaded songs land in `fixtures/tracks/` (gitignored) |
| `infra`, `fly.toml` | the server's Docker image and Fly.io config |
| `docs` | design docs and the operations runbook (table below) |

Production: the web app is on Vercel, the server on Fly.io (`api.playhivemusic.com`, one machine, a 1 GB volume
for uploaded songs). Rooms live in the server's memory.

## Run it locally

You need [Bun](https://bun.sh) 1.4.x (the repo pins 1.4.2), Node.js 20+ (Next.js and Playwright run under it) and git.

```
# Windows:  winget install Oven-sh.Bun OpenJS.NodeJS.LTS Git.Git      (then open a NEW terminal)
# macOS:    brew install oven-sh/bun/bun node git

git clone https://github.com/piar1243/hive-music-official.git
cd hive-music-official
bun install
bun run fixtures                    # generates the two synthetic tracks (WAVs are not in git)

bun run --cwd apps/server dev       # terminal 1: the server, http://localhost:8080
bun run --cwd apps/web dev          # terminal 2: the web app, http://localhost:3000
```

Open http://localhost:3000, tap **Host a hive**, then open the join link in a **different browser or a private
window** (two tabs of one browser share storage and steal each other's identity).

- **Port 8080 already in use?** (Common on a dev machine.) Create `apps/server/.env` containing `PORT=8787`, and
  `apps/web/.env.local` containing `NEXT_PUBLIC_API_URL=http://localhost:8787` and
  `NEXT_PUBLIC_WS_URL=ws://localhost:8787/ws`, then restart both. [`.env.example`](.env.example) lists every
  variable; none is required. For another web port: `cd apps/web && bun x next dev -p 3001`.
- **`NEXT_PUBLIC_*` values are read when the web dev server starts.** Restart it after changing them.
- **Real phones** need HTTPS and a public address. On Windows, `scripts\phone-test.ps1` starts both dev servers
  behind two throwaway Cloudflare tunnels and prints the URL to open — the way to try unreleased code on real
  phones without touching production. On macOS do the same by hand: `cloudflared tunnel --url http://localhost:8080`
  and `…:3000`, then put the server tunnel's URL in the two web variables above.
- **Windows:** details and gotchas in [docs/11-windows-dev.md](docs/11-windows-dev.md).
- **UI work without a server:** `bun run mock --scenario apps/web/mocks/scenarios/party-12.json` serves a scripted
  12-phone party on `:8080`; start the web app with `NEXT_PUBLIC_HIVE_ENGINE=stub` for the audio-less engine.

## Testing

```
bun run typecheck      # all four packages
bun run lint           # the web app
bun run test           # unit tests (bun:test): protocol, sync-client, server
bun run e2e            # Playwright, against the mock server and the stub engine
bun run check          # all of the above, in that order
```

- e2e starts its own web server and mock servers; nothing needs to be running. One file:
  `bun run e2e f5-modes.spec.ts`. The first time: `cd apps/web && node ../../node_modules/@playwright/test/cli.js install chromium`.
- Run Playwright through node (that is what `bun run e2e` does). `bun x playwright` cannot launch the browser on Windows.
- Ports come from the environment so several checkouts can run at once: `PW_WEB_PORT` (default 3100),
  `HIVE_MOCK_PORT` (default 8080 — set it if 8080 is taken). The header of
  [`apps/web/playwright.config.ts`](apps/web/playwright.config.ts) lists the rest.
- The suite rewrites the screenshots in `evidence/frontend/`. Run `git checkout -- evidence/frontend` before committing.
- Web production build check: `cd apps/web && bun run build`. Never while `next dev` or the e2e suite is running
  in that folder (it corrupts the dev cache).
- The server image: `sh infra/smoke-test.sh` (needs Docker) builds it and checks that it boots, seeds, drops
  root and accepts an upload.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same gates on every push, plus the web
production build and the image smoke test.

## Deploying

Both halves are deployed **by hand**; pushing to GitHub deploys nothing. The full procedure — checks, what a deploy
does to running parties, verification, rollback, the volume, incident checklists — is
**[docs/13-operations.md](docs/13-operations.md)**. In short, from the repo root:

```
vercel deploy --prod --yes          # web  -> playhivemusic.com
flyctl deploy --remote-only         # server -> api.playhivemusic.com
```

Two things to know before running the second one: **a server deploy ends every party in progress** (rooms are
in memory and codes are random), and there must only ever be **one** server machine. Roll back with
`vercel rollback` and `fly deploy --image <previous image>` (runbook §4).

## Documentation

| doc | status |
|---|---|
| [13-operations.md](docs/13-operations.md) | **current** — deploy, verify, roll back, volume, incidents |
| [11-windows-dev.md](docs/11-windows-dev.md) | **current** — Windows setup notes |
| [12-domain.md](docs/12-domain.md) | DNS records are current; the setup steps are historical |
| [02-protocol.md](docs/02-protocol.md), [05-effect-modes.md](docs/05-effect-modes.md) | the wire contract and the modes; `packages/protocol/src` is the source of truth |
| [00-context.md](docs/00-context.md), [01-architecture.md](docs/01-architecture.md), [03-sync-engine.md](docs/03-sync-engine.md), [04-calibration.md](docs/04-calibration.md), [06-hive-map-ui.md](docs/06-hive-map-ui.md), [07-tech-stack.md](docs/07-tech-stack.md) | design docs from the build. The reasoning holds; details have moved (no lobby screen, no nudge slider, no fixed room code). Where a doc and the code disagree, the code is right. |
| [08-roadmap.md](docs/08-roadmap.md), [09-deploy.md](docs/09-deploy.md), [10-contingency.md](docs/10-contingency.md), [PROTOCOL-REQUESTS.md](docs/PROTOCOL-REQUESTS.md), [`agents/`](agents), [`evidence/`](evidence) | **historical** — the hackathon's plan, deploy notes, demo fallbacks, agent briefs and gate evidence. Kept for the record; do not follow them. |

Working on the code with a coding agent? Start with [`CLAUDE.md`](CLAUDE.md).

## License

No license has been chosen yet, so all rights are reserved for now: you are welcome to read the code, but
there is no permission to reuse it until a license file says so.

## Prior art we lean on

[Beatsync](https://github.com/freeman-jiang/beatsync) (MIT; the NTP math and the shared-schema shape),
[Snapcast](https://github.com/badaix/snapcast) (the native sync ceiling), AmpMe (per-device latency table),
BeepBeep (SenSys 2007, acoustic ranging), Demucs (stems).
