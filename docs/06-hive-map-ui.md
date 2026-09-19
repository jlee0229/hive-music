# 06 · Host mode and player mode — the UI spec

Owner: frontend agent. Design canvas: **https://claude.ai/artifact/1CPiXwhDfDPqRenDQC9Nzb** (ten artboards: five player-mode,
five host-mode; the "Player · Playing" board has a *part* tweak that previews every role color). The canvas is the visual
reference; this document is the functional contract: which screen exists, what state it shows, which messages it sends.
Visual details may be revised in a later session; the states and messages here are stable.

## Design tokens (also on the canvas as a sticky)

| token | value | use |
|---|---|---|
| stage | `#0B0F14` | page background everywhere |
| surface / raised / border | `#151B23` / `#1E2733` / `#2A3441` | cards, bars, outlines |
| text / muted / faint | `#F1F5F9` / `#94A3B8` / `#64748B` | copy, secondary copy, hints |
| primary action | ivory `#F1F5F9` fill, `#0B0F14` text | exactly one per screen |
| parts | `ROLE_COLORS` from `@hive/protocol`: drums `#F59E0B`, bass `#8B5CF6`, vocals `#22D3EE`, other `#34D399`, unison `#F8FAFC`; host = hollow ring `#F1F5F9` | dots, player screens, legend |
| health rings | `HEALTH_COLORS`: good `#22C55E` (≤5 ms), warn `#EAB308` (≤20 ms), bad `#EF4444`, unknown `#64748B` | via `healthLevel()` only |
| ringer warning | `#F5C451` on `#1F1A0F` | iOS silent-switch banner |
| type | Bricolage Grotesque (display), IBM Plex Sans (body), IBM Plex Mono (codes, ms) | Google Fonts |
| shape | radii 14–24 px; touch targets ≥44 px; 20–24 px side gutters | |

Tailwind v4 is set up in `apps/web`; put the tokens in `app/globals.css` as CSS variables and reference them from classes.

## Rules that apply to every screen

- **No own AudioContext or WebSocket.** Everything goes through `createHiveClient()` from `@hive/sync-client`
  (`apps/web/lib/useHiveClient.ts` wraps it in a hook). Colors come from `ROLE_COLORS`/`HEALTH_COLORS`, never re-declared.
- Render from the latest `ROOM_STATE` snapshot; it is complete and idempotent. Never diff snapshots.
- 60 fps visuals (pulse, wave sweep) read `client.clock.trackTimeSec()` inside `requestAnimationFrame`; they never subscribe per frame.
- Every screen has a **reconnecting** banner (`connection === 'reconnecting'`) and an **ended** state (`room === null` after `KICKED` / room gone).
- HTTPS only in production (wake lock, mic, audio session). No service worker (stale-bundle risk during the hackathon); manifest only.
- Accessibility as drawn: real `<button>`, `<a>`, `<input>` + `<label>`; `aria-label` on icon-only buttons; text contrast ≥4.5:1.

## Player mode — `/j/[code]` (every phone in the crowd)

| screen | shows | sends / calls | leaves when |
|---|---|---|---|
| **Join** | code chip, name input (persisted in localStorage), iOS ringer banner (only on `browserFamily === 'ios-safari'`), "what happens next", one big **Tap to join** | `audio.unlock()` inside the tap, then `connect()` → `JOIN {kind:'player', plays:true}` | `WELCOME` received and `audio !== 'locked'` |
| **Ready** | Synced ring + `status.syncErrMs` / `rttMs`, stem download progress (`audio.loadProgress`, "3 / 4 parts"), *You'll play* card from `assignment` (label + color), "waiting for the host", "keep your screen on" | engine sends `CLIENT_STATUS` every 2 s and `AUDIO_READY` when decoded | `room.transport.state === 'playing'` |
| **Playing** | full-screen `assignment.color`, pulse rings driven by beat (`trackTimeSec` × `track.bpm`) and by `evaluatePattern(assignment.pattern, trackTimeMs)` for WAVE/STROBE, role label, track title + time, sync pill, **nudge slider** (−100…+100 ms, labels "sounds early / sounds late"), **Mute** | `nudgeSelf(ms)` on slider release (debounced 150 ms); `audio.setMuted()` | transport paused/stopped → back to Ready with "paused" copy |
| **Calibrating** | "Hold still. Quiet, please.", countdown ring, phone-N-of-M progress dots from `room.calibration`, white **flash** on the `calibrationClick` event | nothing (the engine plays the click on schedule) | `room.calibration.state` ∈ done/failed/idle |

Player mode never shows the map or any host control. If the host kicks the phone, show "Removed from hive" with a link to `/`.

## Host mode — `/h/[code]` (the host's phone; cast it to a screen if one exists)

Host UI is phone-first (390 × 844) and must remain usable when mirrored to a TV. The host joins with `kind:'host'`,
`plays:false` and the `hostKey` from `POST /rooms` (kept in localStorage per code). `plays` toggles via `SET_PLAYS`.

| screen | shows | sends / calls | leaves when |
|---|---|---|---|
| **Lobby** | big code, QR of `joinUrl` (`qrcode` lib), "N joined" dots, **speaker toggle** ("use this phone as a speaker too"), library list with search box (`GET /tracks?q=`), selected track, **Start the hive** | `POST /rooms {code: ROOM_FIXED_CODE?}` on first load; `host.setTrack(id)` on select; `host.setPlays()`; `host.play(0)` on Start (disabled until every connected player has `audioReadyTrackId === track.id`, with a "start anyway" override after 10 s) | Start pressed |
| **Stage** | header (code, players / in-sync / drifting counts from `healthLevel`), **transport card** (pause/play, title, mode name, time, seek bar), **mode chips** (Unison · Orchestra · Stereo · Wave · Strobe), **vibe box + Direct** and the **scene strip** (`room.scenePlan.scenes`, current from `activeSceneIndex`), the **Hive Map**, legend, **Tune the hive** and **Players** buttons | `host.pause()/play()/seek()`, `host.setMode(kind)`, `host.vibe(prompt)` (spinner ≤5 s, then strip fills), map gestures below | Tune → Calibrate; Players → drawer |
| **Hive Map** (inside Stage) | one dot per client at `position` (unplaced dots line up along the bottom edge with a "drag me" hint), fill = `assignment.color`, ring = `healthLevel(HEALTH[id])`, host dot hollow/dashed, name under dot, WAVE: dots brighten in sweep order via `evaluatePattern`; STROBE: dots blink in groups | **drag** → `host.setPosition(id, x, y)` throttled to 10 Hz, final value on release; **tap** → cycle `pinnedRole` through the track's stems then null (`host.assign`); **long-press / tap-a-dot** → **Player sheet** | – |
| **Player sheet** (bottom sheet over Stage) | name, device family, health numbers (`syncErrMs`, `rttMs`, `compensationMs`), **part pills** (pin), "keep this part when others join" (pin checkbox), **nudge slider**, Remove | `host.assign(id, role\|null)`, `host.nudge(id, ms)`, `host.kick(id)` | tap outside / swipe down |
| **Calibrate** ("Tuning moment") | "Quiet, please." countdown ring, per-player rows (waiting / listening… / clear ✓ with `residualMs` and confidence), explanation copy, **Apply offsets**, Cancel | `host.startCalibration()` → engine runs `calibration.runAsReference({onProgress})` on this phone (mic permission prompt appears here; explain it in copy first); rows come from `room.calibration.results` | done → Stage; failed → retry copy |
| **Players drawer** | list sorted by health: dot (role color + health ring), name, device · role, clock error, offset (`compensationMs`), nudge; tap → Player sheet; Back to the stage | – | – |

Host mode also owns `/diag` (route guard: none) which prints `ctx.state`, `sampleRate`, `outputLatencyMs`, `clockOffsetMs`,
`rttMs`, `syncErrMs`, `audio` state, wake-lock state and `navigator.audioSession?.type` — the 30-second phone checklist for gates F1/F3.

## Landing — `/`

"Host a hive" → `POST /rooms` then `/h/[code]`; code input + Join → `/j/[code]`. Copy: "Runs in your browser. Nothing to install."

## Message ↔ screen matrix (what the frontend agent is responsible for sending)

| message | from screen | via |
|---|---|---|
| `JOIN` | Join (player), Lobby (host) | `connect()` |
| `SET_TRACK`, `SET_PLAYS`, `TRANSPORT` | Lobby, Stage | `host.setTrack / setPlays / play / pause / seek` |
| `SET_MODE` | Stage chips | `host.setMode` |
| `SET_POSITION`, `ASSIGN`, `NUDGE`, `KICK` | Hive Map, Player sheet | `host.setPosition / assign / nudge / kick`, `nudgeSelf` |
| `CALIBRATION_START` (+ `CALIBRATION_REPORT` by the engine) | Calibrate | `host.startCalibration` |
| `POST /rooms/:code/vibe` | Stage vibe box | `host.vibe` |
| `AUDIO_READY`, `CLIENT_STATUS`, `NTP_REQUEST`, `PONG` | — | engine, automatic |

## Mock scenarios (frontend-owned, `apps/web/mocks/scenarios/`)

`party-12.json` (12 players, ORCHESTRA, playing, a scene plan), `calibrating.json` (6 players, tuning in progress),
`restart.json` (chaos: the mock drops every socket after 20 s → exercise the reconnect banner and recovery within 5 s).
Run one with `bun run mock --scenario apps/web/mocks/scenarios/party-12.json`.
