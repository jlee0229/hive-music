# HiveMusic — Context and Reality Check

Owner: both

HiveMusic turns a crowd's phones into one distributed speaker: the host's phone creates a room, players scan a QR code, every phone syncs to a shared clock, and the room plays one track together — as a unison wall of sound, as an orchestra with each phone on a different stem, or as spatial effects that sweep across the crowd. This document is the shared frame both agents build against. Read it first, then [01-architecture.md](01-architecture.md) and [02-protocol.md](02-protocol.md).

## Vision and honest pitch

What we are selling, in order of how much it matters:

1. **Loudness.** Ten phones playing the same thing at the same time are about 10 dB louder than one phone. That is the difference between "someone's phone" and "the music is on".
2. **Unity.** When device-to-device error is under ~10–20 ms the ear fuses the phones into one source. The room stops sounding like a crowd of phones and starts sounding like a room.
3. **Effects only a crowd can do.** Different stems on different phones (ORCHESTRA), left/right zones (STEREO), delays that roll across the room (WAVE), rhythmic gating that ping-pongs between groups (STROBE). A host types a vibe and Claude plans a scene sequence on the shared timeline.

What we are **not** selling: literal constructive interference or "phased array" beamforming. See the physics section — it does not work with phone speakers in a room, and we do not pretend it does.

Product rules locked with the user (see the plan): the host is a phone — no laptop anywhere in the flow; the host UI can be mirrored to a screen. Host phones do not play audio unless the "use this phone as a speaker too" toggle is on. Music comes from a pre-loaded library. The demo must work with no Anthropic key via the rules fallback.

## The pipeline

| Step | Who | What happens | Doc |
|---|---|---|---|
| 1. Host a hive | host phone | `POST /rooms` → `{code, hostKey}`; Host · Lobby shows the code and a QR to `/j/<code>` | [06](06-hive-map-ui.md) |
| 2. Join | player phones | Scan QR → `/j/<code>` → name → "Tap to join" unlocks audio → `JOIN` | [02](02-protocol.md), [03](03-sync-engine.md) |
| 3. Sync | every phone | NTP-style probes to the server; clock offset within ±2–5 ms; all stems preload; `AUDIO_READY` | [03](03-sync-engine.md) |
| 4. Assignment | server | Planner gives each playing phone `{gainsDb, delayMs, color, label, pattern?}` inside `ROOM_STATE` | [05](05-effect-modes.md) |
| 5. Tuning moment | host phone + players | Tier 1 table + nudge; Tier 2: the host phone listens to one click from each player and corrects per-phone offsets — staged as the demo's "orchestra tunes up" beat | [04](04-calibration.md) |
| 6. Concert | everyone | `TRANSPORT PLAY` → one timeline; mode chips and vibe prompts change assignments as gain ramps on the shared clock | [05](05-effect-modes.md) |

## Physics reality check

Numbers we design around (verified; sources in the plan):

| Fact | Number | Consequence |
|---|---|---|
| Speed of sound | ~343 m/s ≈ **2.9 ms per metre** | A listener 3 m from one phone and 0 m from another hears 8.7 ms of skew no software can remove. |
| Phone speaker low-frequency cutoff | nothing below **~150 Hz** | No bass reinforcement by interference; the bass stem still sounds like phone bass. |
| Room multipath | phase randomised above **~500 Hz** | Coherent (phase-aligned) summation is not achievable; do not chase it. |
| Incoherent power summation | **+10·log10(N) dB** → 10 phones ≈ **+10 dB** | The loudness win is real and needs only rough sync. |
| Perceptual fusion | **<10–20 ms** = one source; **30+ ms** smears; **>50 ms** = echo | Sets the ≤10 ms target and the ≤30 ms floor. |
| Deliberate delay | 0–300 ms across the room | Makes WAVE audible as a sweep rather than an error. |

Therefore:

- **Target:** ≤10 ms device-to-device (fusion with margin). **Floor:** ≤30 ms — never ship worse; above it the room hears smear and we re-calibrate or cut.
- **Clock budget:** ±2–5 ms for the NTP-style clock over one Wi-Fi/hotspot. Cellular RTT asymmetry (10–30 ms) alone breaks the target, so the demo runs on one Wi-Fi/hotspot.
- **Output latency is the big unknown:** `AudioContext.outputLatency` is unreliable on iOS Safari and varies 20–100+ ms across Android devices. This is why a per-browser-family table, a nudge slider and click calibration exist.

## Error budget

Per-component budget in ms, device-to-device. "Sum" is worst case; "RSS" is root-sum-square, the typical case. Mechanisms for each column are in [03-sync-engine.md](03-sync-engine.md) and [04-calibration.md](04-calibration.md).

| Source | Uncorrected | After Tier 1 table | After table + nudge | After Tier 2 calibration |
|---|---|---|---|---|
| Clock sync (min-RTT NTP over Wi-Fi) | ±2–5 | ±2–5 | ±2–5 | ±2–5 |
| Output-latency unknown | 20–100+ (iOS unreliable; Android spread) | ±10–20 (spread within one browser family) | ±5 (limit of "I sound early/late" by ear) | ±2–3 (cross-correlation; ≤1 m to the host mic) |
| Scheduler quantum (128-sample render quantum) | ≤3 | ≤3 | ≤3 | ≤3 |
| **Sum** | 25–108 | 15–28 | 10–13 | 7–11 |
| **RSS** | — | ~11–21 | ~6–8 | ~4–7 |
| Propagation, listener 3 m from the far phone | +8.7 | +8.7 | +8.7 | +8.7 (inherent to the room; not corrected) |
| vs ≤10 target / ≤30 floor | fails both | floor met; target not guaranteed | target reachable per phone by ear | target met |

Per mode:

| Mode | Needs (device-to-device) | Why | Tier 1 only | Tier 1 + nudge | Tier 2 |
|---|---|---|---|---|---|
| UNISON | ≤10 target, ≤30 floor | identical signal everywhere; error = smear/comb filtering | marginal | ok | ok |
| ORCHESTRA | ≤20 | different stems per phone; error reads as a loose band, not smear | ok | ok | ok |
| STEREO | ≤20 | two zones with different stems | ok | ok | ok |
| WAVE | ≤30 | intentional 0–300 ms delays dwarf the error | ok | ok | ok |
| STROBE | ≤30 | 500 ms period; 30 ms is 6 % of it | ok | ok | ok |

## Prior art

| Project | What we take | Link |
|---|---|---|
| Beatsync (MIT) | Turborepo + Bun + Next.js + Tailwind/shadcn shape; zod discriminated-union schemas (`packages/shared/types/{WSRequest,WSBroadcast,WSUnicast}.ts`); NTP math in `apps/client/src/utils/ntp.ts` (`t0..t3`, offset/rtt, min-RTT selection, coded probe pairs); the SCHEDULED_ACTION idea. We port the math, not the repo — its server needs Cloudflare R2, a music provider, chat and backups. | https://github.com/freeman-jiang/beatsync |
| Snapcast | Proof that <0.2 ms multi-room sync is achievable natively: the ceiling a browser will not reach | https://github.com/badaix/snapcast |
| AmpMe (commercial) | Validated the per-device latency table + manual nudge approach | https://ampme.com |
| BeepBeep (Peng et al., SenSys 2007) | Two-way acoustic ranging, 1–2 cm, cancels clock/latency unknowns — stretch only, for auto-placement | https://doi.org/10.1145/1322263.1322265 |
| Demucs `htdemucs` (MIT) | 4-stem separation; stems sum ≈ mix, which is why UNISON = all stems at 0 dB | https://github.com/facebookresearch/demucs |
| Replicate-hosted Demucs | ≈ $0.02/run, 30–120 s per track → upload path is B9 stretch, never on the demo critical path | https://replicate.com |

## Licensing and content

- HiveMusic is for **private parties**: a host plays their own files (or our library) to their own guests. It is not a public performance service and we do not frame it as one.
- The library ships **pre-separated demo tracks**: the synthetic `synthetic-60s` from `fixtures/gen-synthetic.ts` plus tracks we hold rights to ((assumption) CC-licensed or self-made). The host gets a search box over that library (`GET /tracks?q=`).
- **No external catalog search.** Streaming APIs forbid this use in their ToS, and download-then-separate takes 3–4 min per track and violates ToS too. Neither is worth the demo risk.
- Uploading the host's own file (Replicate Demucs) is B9 stretch only.

## Demo constraints

| Constraint | Why |
|---|---|
| Every phone on one Wi-Fi/hotspot | symmetric RTT; cellular asymmetry breaks the ≤10 ms target |
| HTTPS everywhere (Vercel + Fly) | Wake Lock, `getUserMedia`, and secure-context APIs require it |
| iOS ringer switch on, or `navigator.audioSession.type='playback'` (Safari 17+) | otherwise Web Audio is muted |
| Every join is a tap | `AudioContext.resume()` must run inside a user gesture; the same tap after a lock-screen `interrupted` state |
| Screens stay on | Wake Lock; audio dies with the tab on iOS |
| ≥6 phones for the finale | +7.8 dB at 6, +10 dB at 10; effects need bodies in the room |

## Vocabulary

| Term | Meaning |
|---|---|
| host | The phone that created the room (`kind:'host'`); holds `hostKey`; does not play unless `plays:true` |
| player | A phone that joined via `/j/<code>` (`kind:'player'`, `plays:true`) |
| stem | One mono 16-bit WAV of a track (`drums`, `bass`, `vocals`, `other`, or `mix` for a non-stem track); ≤4 per track, ≤60 s |
| assignment | Per-client `{label, color, gainsDb, delayMs, compensationMs, pattern?, applyAtServerTime?}` from `plan(room)` |
| server time | Master clock, ms floats; every scheduled event is expressed in it |
| compensation | `nudgeMs + (calibratedOffsetMs ?? tableLatencyMs)`; positive = device is late → play it earlier |
| tuning moment | Tier 2 calibration run from the host phone, staged as part of the show |
| gate | A deliverable with a runnable check and a named evidence file (B0–B9, F0–F9); see [08-roadmap.md](08-roadmap.md) |

## Canonical numbers

Every doc, brief and constant must agree with this table (the IC0 verification step diffs them). Names are the intended identifiers in `packages/protocol/src/constants.ts` (assumption on exact spelling).

| Constant | Value | Where it bites |
|---|---|---|
| `SYNC_TARGET_MS` | 10 | device-to-device target; rig gates B3/B4; IC2 exit criterion |
| `SYNC_FLOOR_MS` | 30 | never ship worse; re-calibrate or cut above it |
| clock budget | ±2–5 ms | NTP client over one Wi-Fi/hotspot |
| `LEAD_MS` | 600 | PLAY lead; scene timer fires this early |
| `HEALTH_GOOD_MS` / `HEALTH_WARN_MS` | 5 / 20 | `healthLevel`: good ≤5, warn ≤20, bad >20 |
| `HEALTH_STALE_S` | 5 | `lastSeen` >5 s → unknown |
| `ROOM_STATE_MAX_HZ` | 2 | coalesced broadcast |
| `HEALTH_HZ` | 1 | hosts only |
| `SET_POSITION_HZ` | 10 | UI throttle while dragging |
| `CLIENT_STATUS_PERIOD_S` | 2 | phone → server status |
| `DISCONNECT_RETENTION_S` | 120 | rejoin keeps identity and assignment |
| `RESYNC_THRESHOLD_MS` / `RESYNC_CROSSFADE_MS` | 10 / 20 | hard resync |
| NTP schedule | 20 probes in 4 s, then 1 Hz; 30-probe window | clock model |
| stems | ≤4, mono, 16-bit WAV, ≤60 s | ≈42 MB decoded per phone |
| `CALIBRATION_INTERVAL_MS` | 400 | one click per player |
| WAVE `spanMs` | 0–300 | per-position delay |
| STROBE defaults | `periodMs 500, duty 0.5, groups 2` | (assumption) |
| `VIBE_MODEL` default | `claude-sonnet-5` | ≈ $0.007 per call |
| `PROTOCOL_VERSION` | 1 at IC0 | bumped only by the backend agent, additively |

## What each agent takes from this doc

- **Backend agent:** the error budget is the acceptance bar for B2–B4 and B8; the clock budget (±2–5 ms) is what the NTP client must deliver on Wi-Fi, and the rig is how you prove the rest. Nothing below 150 Hz and nothing coherent above 500 Hz — do not spend an hour on phase alignment.
- **Frontend agent:** the pipeline table is the screen order; every join is a tap (audio unlock), every phone must stay awake (Wake Lock), and "Synced ±N ms" is `status.syncErrMs`. The tuning moment is a staged beat of the show, so Host · Calibrate deserves a countdown and progress rings, not a spinner.
- **Both:** the demo is on one Wi-Fi/hotspot with ≥6 phones, HTTPS everywhere, no laptop in the flow. When the plan is silent, choose the smallest reasonable thing and mark it "(assumption)" in the doc you own.

## Related

- [01-architecture.md](01-architecture.md) — components, package graph, ownership, data flows
- [02-protocol.md](02-protocol.md) — the contract (mirrors `packages/protocol`)
- [03-sync-engine.md](03-sync-engine.md) — clock, scheduling, resync, latency table
- [04-calibration.md](04-calibration.md) — Tier 1 / Tier 2 and the rig
- [05-effect-modes.md](05-effect-modes.md) — the five modes and the Vibe Director
- [08-roadmap.md](08-roadmap.md) — gates, checkpoints, cut list, demo script
