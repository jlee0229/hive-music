# HiveMusic

**Every phone in the room. One speaker.** A web app for HackMIT 2026: the host runs it on their phone, friends scan a QR code,
and every phone plays the same music in sync, louder together, with per-phone instrument parts and room-scale effects.
Nothing to install.

## What it really does (honest pitch)

Phones cannot beam-form: their speakers put out nothing below ~150 Hz and room reflections scramble phase above ~500 Hz.
What N phones *can* do, when they are within about 10 ms of each other:

- **Loudness** — incoherent power summation, ≈ +10 dB for ten phones.
- **Unity** — under 10–20 ms the ear hears one source instead of a smear of echoes.
- **Effects** — with each phone's position known, deliberate delays and gain patterns sweep sound across the crowd, and
  each phone can play a different instrument stem.

Engineering target: **≤10 ms** device-to-device after calibration, **≤30 ms** floor. Details in [docs/00-context.md](docs/00-context.md).

## The pipeline

```
host phone ──POST /rooms──▶ room code + QR
   │
   ├─ phones scan ──▶ /j/CODE ──▶ tap to join (unlocks audio) ──▶ NTP-style clock sync over WebSocket (±2–5 ms)
   │                                                               ──▶ preload every stem (WAV)
   ├─ tuning moment: host phone listens, each phone plays one click ──▶ per-phone latency offsets
   │
   ├─ host picks a mode (Unison · Orchestra · Stereo · Wave · Strobe) or types a vibe ──▶ server plans per-phone gains/delays
   │
   └─ PLAY at serverTime T ──▶ every phone starts on the same instant, keeps itself within 10 ms, ramps gains on cue
```

## Repo map

| path | what |
|---|---|
| `packages/protocol` | **the contract**: zod schemas, planner, patterns, health, scene plans, constants, mock server |
| `packages/sync-client` | the headless browser engine (clock sync, scheduling, drift, calibration) + a no-audio stub |
| `apps/server` | Bun WebSocket + REST server (rooms, timeline, planner, vibe director) |
| `apps/web` | Next.js PWA: host mode `/h/[code]`, player mode `/j/[code]` |
| `fixtures` | synthetic 4-stem test track generator; where pre-separated demo tracks go |
| `docs` | context, architecture, protocol, sync engine, calibration, modes, UI spec, stack, roadmap |
| `agents` | the two build briefs and the shared rules |
| `infra` | Fly.io config |

## Start here

- Building it: read [`CLAUDE.md`](CLAUDE.md), then [`agents/SHARED-RULES.md`](agents/SHARED-RULES.md), then your brief
  ([backend](agents/BACKEND-AGENT.md) · [frontend](agents/FRONTEND-AGENT.md)).
- Design canvas (host mode + player mode screens): https://claude.ai/artifact/1CPiXwhDfDPqRenDQC9Nzb
- Roadmap, checkpoints and the 3-minute demo script: [`docs/08-roadmap.md`](docs/08-roadmap.md)

```
bun install && bun run fixtures
bun run typecheck && bun run test
bun run mock --scenario apps/web/mocks/scenarios/party-12.json   # then: bun run --cwd apps/web dev
```

## Prior art we lean on

[Beatsync](https://github.com/freeman-jiang/beatsync) (MIT; the NTP math and the shared-schema shape), [Snapcast](https://github.com/snapcast/snapcast)
(the native sync ceiling), AmpMe (per-device latency table + nudge), BeepBeep (SenSys 2007, acoustic ranging — stretch), Demucs (stems).
