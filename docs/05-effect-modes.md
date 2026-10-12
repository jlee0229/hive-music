# HiveMusic — Effect Modes and the Vibe Director

Six modes, all produced by the pure `plan(room)` in `packages/protocol/src/planner.ts` as per-client assignments `{label, role, color, gainsDb, delayMs, compensationMs, pattern, applyAtServerTime, pitchSemitones?}`. Switching modes never loads anything: every phone already holds all stems ([03](03-sync-engine.md)), so a switch is a set of gain ramps on the shared clock (CHOIR additionally re-renders the phone's copy at a new pitch). A vibe prompt produces a `ScenePlan` the server plays back as timed mode switches. Message shapes: [02-protocol.md](02-protocol.md).

## Planner contract (as implemented)

- Input: `room` (uses `mode`, `track`, `clients`). Output: an `assignment` for every client with `plays: true` — connected or not, so a phone that drops for a minute keeps its seat — and `null` for everyone else (non-playing hosts, viewers).
- **The whole song stays in the room.** In every mode, every stem of the track is audible on at least one *connected* speaker. Coverage counts connected speakers only (a phone in a pocket covers nothing); with nobody connected, everyone counts. The one exception is the host's own doing: ORCHESTRA with every connected speaker pinned.
- **A joiner never changes who anyone is.** Every deal (instrument, strobe group, choir voice, map slot) is made in `joinIndex` order with the speaker's own `joinIndex` as the tie-break, so a newcomer can only take load *off* existing speakers, and a leaver moves only the speakers that have to move. The cases where a join must change others are named per mode below.
- Pure and deterministic: same room in, same plan out, whatever the key order. No rounding of pattern timings.
- Silent stems are `SILENT_DB = −60`; audible stems `0` plus the optional per-stem trim `mode.params.stemGainsDb[stem]` (−60..12), clamped at −60. Trims never un-silence a stem.
- A non-stem track has one stem named `mix`; ORCHESTRA/STEREO collapse to unison gains for it; WAVE/STROBE/CHOIR still apply delay/pattern/pitch.
- `compensationMs` is copied from the client record into the assignment so the phone reads one object.
- `applyAtServerTime` is set only by the scene timer (`withAssignments(room, boundary)`); manual changes carry `null` and apply immediately.
- Params are validated by `ModeParamsSchema` (unknown keys stripped); `resolveModeParams` fills defaults `axis 'x'`, `spanMs 240`, `periodMs 500`, `duty 0.5`, `groups 2`, `beatsPerSwitch 1`.
- `connected` is a planner input, so a server must re-plan when a socket closes or a retained record expires. The mock does; `apps/server` currently only re-publishes there, so a fold appears at the next re-plan (audit finding PROTO-05).
- Property tests: `packages/protocol/src/__tests__/plan-properties.test.ts`, `orchestra.test.ts`, `strobe.test.ts`, `layout.test.ts`.

### Where an unplaced phone is: the shared auto-layout

`position: null` means "nobody dragged this dot". Its position is then `speakerLayout(room).positions[id]` (`packages/protocol/src/layout.ts`) — one pure function used by the planner (WAVE, STEREO) **and** by the Hive Map, so what the host sees is what the room hears.

- Shape: slot 0 is the centre; ring *k* is a circle of radius *k*·spacing with 6*k* slots. `spacing = min(0.19, 0.42 / rings)`; the ring count grows with the head count: 19 / 37 / 61 / 91 / … / 217 slots. Up to 19 speakers this is exactly the map's historical look (rings at 0.19 and 0.38); 60 speakers get 0.105 between dots (37 px on the 350 px map). The result carries `spacing` so the map can size its dots.
- Slot = `joinIndex mod capacity`, lower `joinIndex` wins, linear probe on a conflict. A joiner never moves anyone; a leaver moves nobody unless a speaker had been bumped off its own slot (needs `joinIndex` > capacity). The layout rescales only when the count crosses a capacity.
- Inside a ring the order is "most horizontal first, alternating left / right", so the first phones spread along x and STEREO's two sides fill evenly. No ring slot is on the vertical centre line.
- Auto slots keep at least `0.9 × spacing` away from hand-placed speakers; if those eat the capacity, the hive grows a ring.

## The six modes

Labels are lowercase strings from the planner; the UI capitalises for display.

### UNISON

| | |
|---|---|
| Listener hears | Every phone plays the whole mix; the room is +10·log10(N) dB louder than one phone and, under ~10–20 ms, sounds like one source |
| Planner rule | all stems `0 dB`; `delayMs 0`; `pattern null`; `label 'unison'`; `role 'unison'`; `color ROLE_COLORS.unison` |
| Sync needed | ≤10 ms target, ≤30 ms floor — the most demanding mode |
| Map fidelity | none (positions ignored) |
| Stems needed | any (works with `mix`) |
| Params | `{ stemGainsDb? }` |

### ORCHESTRA

| | |
|---|---|
| Listener hears | Each phone is an instrument; walking the room walks through the band — and the band is always complete |
| Planner rule | `arrangeOrchestra(room)`. **Primary** instrument per speaker: its pin if it has one, otherwise dealt balanced over `drums, vocals, bass, other` (rhythm and melody alternate, so two phones that joined back to back split the band sensibly). **Folding:** every track stem that no connected speaker has as primary is added to a connected, unpinned speaker — the rhythm/melody partner (`drums↔bass`, `vocals↔other`) if there is one, else whoever plays the least. So: 1 phone → everything (`label`/`role` `unison`); 2 → `drums + bass` / `vocals + other`; 3 → `drums + bass` / `vocals` / `other`; 4 → one each; N > stems → doubled evenly (max − min ≤ 1). A phone that drops offline has its stem carried by its partner until it is back. `label` = the stems it plays (`'drums'`, `'drums + bass'`), `role`/`color` = the primary. No real stems → unison gains |
| Pins | a pinned speaker plays exactly its pin and is never folded onto. Pin every phone and the host has chosen what the room hears |
| Join stability | a joiner never changes anyone's primary; it can take folded stems away |
| Sync needed | ≤20 ms (error reads as a loose band, not smear); ≤10 still the target |
| Map fidelity | none for audio; roles show as dot colours; tap-to-cycle sends `ASSIGN` |
| Stems needed | ≥2 real stems (else collapses to UNISON gains) |
| Params | `{ stemGainsDb? }` |

### STEREO (zone-based stem grouping)

| | |
|---|---|
| Listener hears | Rhythm section on the left of the room, vocals and the rest on the right — a wide image built from mono stems |
| Planner rule | `left = x < 0.5` at the speaker's effective position (its own, or its auto-layout slot). left: `drums 0, bass 0, vocals −60, other −60`; right: the inverse; if the track lacks the zone's stems, all stems; `label 'left' / 'right'`; `role 'drums' / 'vocals'` (left amber, right cyan). **Until there is a connected speaker on both sides** — one phone alone, every dot in the same half, the only right-hand phone offline — everyone plays the full mix (`label`/`role` `unison`): half a song is worse than no effect |
| Join stability | the first speaker to appear on the empty side turns the split on for everyone |
| Sync needed | ≤20 ms |
| Map fidelity | coarse: which half of the map a phone is in |
| Stems needed | 4 stems; with 2 stems, one per zone; with `mix`, collapses to UNISON |
| Params | `{ stemGainsDb? }`; a true L/R split from a stereo mix asset is stretch |

### WAVE

| | |
|---|---|
| Listener hears | The same music rolling across the room: the far side plays up to `spanMs` later, and a slow swell (2 s period) travels along the same axis, so every beat and every swell sweeps from one wall to the other |
| Planner rule | all stems `0 dB`; `proj` = the speaker's effective position on `axis` (its own, or its auto-layout slot — never "the middle"); `delayMs = round(spanMs × proj)`; `pattern {kind:'wave', periodMs: WAVE_SWELL_PERIOD_MS (2000), phaseMs: round(proj × 2000)}`; `label 'wave'`; `role 'unison'` |
| Join stability | nobody moves unless the layout grows a ring (20th, 38th, 62nd … unplaced speaker), which rescales everyone once |
| Sync needed | ≤30 ms (the deliberate 0–300 ms delays and the 2 s swell dwarf it) |
| Map fidelity | real: delay and swell phase are functions of position; a misplaced dot is an audible glitch in the sweep. With few unplaced phones the sweep uses only the part of the span they cover (2–6 auto-placed phones sit at x 0.31 … 0.69) |
| Stems needed | any |
| Params | `{ axis: 'x' \| 'y', spanMs: 0–300 }`; defaults `axis 'x'`, `spanMs 240` (`WAVE_DEFAULT_SPAN_MS`) |

### STROBE

| | |
|---|---|
| Listener hears | The music handed from group to group on the beat, ping-ponging across the room; screens flash with the gate in the group's colour |
| Seating | `arrangeStrobe(room, groups)`: the rotation has `min(groups, connected speakers)` groups — never an empty one — dealt balanced, connected speakers first. `label 'strobe ' + (group + 1)`; `role STEMS[group % 4]` (group 1 amber, 2 violet, 3 cyan, 4 green) |
| Timing, tempo known | one group's turn is a **slot** = `beatsPerSwitch` beats = `60000 / bpm × beatsPerSwitch` ms (2 = half note, 1 = quarter, 0.5 = eighth, 0.25 = sixteenth); `periodMs = slot × groups`, `duty = 1 / groups`, `phaseMs = (beatOffsetSec × 1000 + group × slot) mod periodMs` — each group opens **on a beat-grid line**. Nothing is rounded: at 128 BPM a two-group rotation is 937.5 ms, and rounding it to 938 used to put the last switch of a 4-minute song 128 ms late. Nothing is clamped either; a slot outside `[STROBE_MIN_SLOT_MS 50, STROBE_MAX_SLOT_MS 8000]` is doubled / halved until it fits, so it stays on the grid. **One group** (or one phone) is a plain on/off strobe: `periodMs = 2 × slot`, `duty 0.5` |
| Timing, no tempo | the free-running params: `periodMs`, `duty`, `phaseMs = group / groups × periodMs` |
| Handoff | `rampMs: 10` (`STROBE_RAMP_MS`), centred on the window edges, so back-to-back groups cross-fade and their gains sum to exactly 1 — there is no instant when the room is silent |
| Join stability | nobody changes group once the rotation is full; while there are fewer speakers than `groups`, each joiner adds a group and re-phases everyone |
| Sync needed | ≤30 ms |
| Map fidelity | none (groups by join order); position-based phase is a later variant |
| Stems needed | any |
| Params | `{ groups: 1–8, beatsPerSwitch: 0.25–4, periodMs: 100–8000, duty: 0.05–1 }`; defaults `2 / 1 / 500 / 0.5`. `periodMs` and `duty` are used only when the track has no `bpm` |

### CHOIR

| | |
|---|---|
| Listener hears | Everyone plays the full mix, each phone at its own pitch — octaves and a fifth around the song at pitch, stacked into one chord |
| Planner rule | `arrangeChoir(room)`: voice = `CHOIR_STEPS[joinIndex % 4]` = `[0, +12, −12, +7]` semitones, with one rule on top — **there is always a root**: the earliest speaker always sings 0, and if no connected speaker is on the root the earliest connected one covers it. All stems `0 dB`; `delayMs 0`; `pattern null`; `pitchSemitones` = the voice. `label` / `role`: 0 `'choir'` / `unison`, +12 `'soprano'` / `vocals`, −12 `'basso'` / `bass`, +7 `'tenor'` / `other` |
| Client | the phone re-renders its copy of the track at that pitch (time-stretch + resample, duration unchanged, never a `playbackRate` change — that would break the shared timeline) |
| Join stability | a joiner never changes anyone's voice — a pitch change is an offline re-render — except a root handing back a root it was only covering |
| Sync needed | ≤20 ms |
| Stems needed | any |
| Params | `{ stemGainsDb? }` |

`evaluatePattern(pattern, trackTimeMs)` in `packages/protocol/src/pattern.ts` returns a gain multiplier in `[0, 1]` (`null` pattern → 1; a non-finite time, period or phase → 1):

```
wave   → t = wrap(trackTimeMs − phaseMs, periodMs)         // ((t % p) + p) % p
         0.5 − 0.5 · cos(2π · t / periodMs)                // raised-cosine swell: 0 at the phase origin, 1 half a period later
strobe → on = (duty ?? 0.5) · periodMs;  on ≥ periodMs → 1;  on ≤ 0 → 0
         ramp = min(rampMs ?? 10, on, periodMs − on);  h = ramp / 2
         t = wrap(trackTimeMs − phaseMs + h, periodMs) − h  // position relative to the opening edge, in [−h, period − h)
         t < h → (t + h) / ramp;  t ≤ on − h → 1;  t < on + h → (on + h − t) / ramp;  else 0
```

The strobe ramps are centred on the two edges of the window (up across `[−h, +h]` around the phase origin, down across the same span around `on`): the gate's area is exactly `duty × period`, and two gates whose windows are back to back sum to exactly 1. The pattern is periodic in both directions, so a negative `trackTimeMs` (the lead-in before a start) is the same gate extended backwards.

Deterministic, evaluated **client-side on the shared clock**: the engine schedules the multiplier as gain automation a window ahead, the UI evaluates it per frame for the screen (WAVE: dots brighten in sweep order; STROBE: dots blink in groups). No per-tick messages ever leave the server; a 60-phone STROBE costs zero bandwidth.

## ROLE_COLORS and health colours

`constants.ts` is the source; the UI imports it and never copies hex values.

| Key | Hex | Used for |
|---|---|---|
| `drums` | `#F59E0B` amber | ORCHESTRA drums; STEREO left; STROBE group 1 |
| `bass` | `#8B5CF6` violet | ORCHESTRA bass; STROBE group 2; CHOIR −12 |
| `vocals` | `#22D3EE` cyan | ORCHESTRA vocals; STEREO right; STROBE group 3; CHOIR +12 |
| `other` | `#34D399` green | ORCHESTRA other; STROBE group 4; CHOIR +7 |
| `unison` | `#F8FAFC` white | UNISON, WAVE, CHOIR root, and any phone playing every stem (ORCHESTRA alone, STEREO before both sides exist) |
| host | hollow ring, stroke `HOST_RING_COLOR #F1F5F9`, no fill | the host dot on the map; a host with `plays:true` is a hollow ring in its role colour |

| Health | Hex | `healthLevel(h, nowServerTime)` |
|---|---|---|
| `good` | `#22C55E` | `|syncErrMs| ≤ 5` and seen within 5 s |
| `warn` | `#EAB308` | `|syncErrMs| ≤ 20` and seen within 5 s |
| `bad` | `#EF4444` | `|syncErrMs| > 20`, **or** `lastSeenServerTime` older than 5 s |
| `unknown` | `#64748B` | no health record, or `syncErrMs` null |

The map draws health as a ring around the dot; the fill is the role colour.

## Vibe Director

The host types a vibe; one structured-output Claude call returns the scene list; the server wraps it as a `ScenePlan` and plays it back on the timeline. Gate B6.

### Schemas (`packages/protocol/src/scene.ts`)

```ts
SceneSchema        { atTrackSec ≥ 0, mode: MODES, params: ModeParamsSchema (default {}), note ≤ 40 chars }
ScenePlanCoreSchema { scenes: Scene[1..12] }                         // the structured-output format for the model
ScenePlanSchema     = core + { prompt ≤ 500, source: 'llm' | 'rules', createdAtServerTime }
                      .refine(scenes strictly ascending by atTrackSec)   // what RoomState.scenePlan holds
activeSceneIndex(plan, trackTimeSec) → index of the active scene, −1 before the first
```

Server normalisation before wrapping (assumption): sort by `atTrackSec`; drop scenes at or beyond `durationSec`; if the first scene is not at 0, prepend `{atTrackSec: 0, mode: 'UNISON', params: {}, note: 'open'}`; merge scenes closer than 2 s (keep the later); if the result still fails `ScenePlanSchema`, use the fallback.

### Inputs to the call

| Input | Source |
|---|---|
| vibe text | `POST /rooms/:code/vibe {prompt}` (`VibeRequestSchema`, 1–500 chars) |
| track meta | `fixtures/tracks/<trackId>/meta.json`: `title`, `durationSec`, `stems[]`, `bpm`, `dropSec?`, `energy[]` (one value per second, 0..1) |
| player count | `count(clients where plays && connected)` |
| current mode | `room.mode` |

### System prompt outline (`apps/server/src/vibe/prompt.ts`)

1. Role: "You are the lighting-and-sound director for a crowd of N phones playing one track together."
2. The modes, one line each: what they feel like and when they work (ORCHESTRA/STEREO need ≥2 stems; WAVE/STROBE are high-energy; UNISON is the calm default). The prompt as shipped (`prompt.ts`) still lists five modes and STROBE's free-running `periodMs`/`duty`: it does not know CHOIR or `beatsPerSwitch` yet.
3. Parameter ranges (as in `ModeParamsSchema`) and their defaults.
4. The energy curve, downsampled to ≤60 numbers, plus the timestamps of the three largest rises (and `dropSec` when the meta has it).
5. Rules: first scene at 0; at most one switch per 8 s; match energy (low → UNISON/ORCHESTRA, rises → WAVE, peaks → STROBE); `note` ≤ 40 chars; never more scenes than `durationSec / 8`.
6. Output only the scene list — the format is enforced by `output_config`.

### The call (`apps/server/src/vibe/director.ts`)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ScenePlanCoreSchema, ScenePlanSchema, type ScenePlan } from '@hive/protocol';
import { rulesFallback } from './rules';

const client = new Anthropic();                       // reads ANTHROPIC_API_KEY

export async function directScene(prompt: string, meta: TrackMeta, playerCount: number, currentMode: string, now: number): Promise<ScenePlan> {
  const wrap = (scenes: Scene[], source: 'llm' | 'rules') =>
    ScenePlanSchema.parse({ prompt, source, createdAtServerTime: now, scenes: normalise(scenes, meta) });
  if (!process.env.ANTHROPIC_API_KEY) return wrap(rulesFallback(prompt, meta), 'rules');
  try {
    const response = await client.messages.parse(
      {
        model: process.env.VIBE_MODEL ?? 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(prompt, meta, playerCount, currentMode) }],
        output_config: { format: zodOutputFormat(ScenePlanCoreSchema) },
      },
      { timeout: 5_000, maxRetries: 0 },              // 5 s budget, no silent retries
    );
    if (response.stop_reason === 'refusal' || response.parsed_output === null) return wrap(rulesFallback(prompt, meta), 'rules');
    return wrap(response.parsed_output.scenes, 'llm');
  } catch {
    return wrap(rulesFallback(prompt, meta), 'rules');
  }
}
```

Fallback triggers: no `ANTHROPIC_API_KEY`, `parsed_output === null`, `stop_reason === 'refusal'`, any thrown error (including a normalised plan that fails the schema), or the 5 s timeout. The response to the host is `{scenePlan}` either way; `source` tells the strip whether Claude or the rules wrote it.

### Scene timer (`apps/server/src/scene-timer.ts`)

- The pure rules (`nextScene`, `currentScene`) live in `packages/protocol/src/timeline.ts`, shared with the mock, which runs the same timer.
- On plan accepted: `room.scenePlan = plan`; broadcast `ROOM_STATE`. If playing, the scene at or before the current position applies immediately with `applyAtServerTime: null`.
- While `transport.state === 'playing'`, arm one timer for the next scene with `atTrackSec > trackTimeSec`: fire at `serverTime = serverTimeAtTrackZero + atTrackSec·1000 − LEAD_MS` (`LEAD_MS = 600`). On fire: `room.mode = {kind: scene.mode, params: scene.params}`, `room = withAssignments(room, serverTimeAtTrackZero + atTrackSec·1000)`, broadcast, arm the next.
- Timers derive from `transport`: PAUSE cancels; PLAY/SEEK re-arms for scenes ahead of the new position, and the latest scene at or before the new position becomes the current mode immediately.
- **Manual override:** any `SET_MODE` sets `scenePlan = null`, cancels the timer and applies immediately (the mock does the same).
- **Playlist advance:** when the track ends and the room moves to the next song, `scenePlan` is cleared — the plan was written for the song that ended. The scene strip empties; the host can submit a new vibe.
- The phone ramps gains at `ctxAt(applyAtServerTime)` ([03](03-sync-engine.md)); all phones switch within the clock budget of each other. The host's strip highlights `activeSceneIndex(room.scenePlan, clock.trackTimeSec())`.

### Rules fallback (`apps/server/src/vibe/rules.ts`)

Keyword table — the first match in prompt order is the base mode; later matches may add scenes:

| Keywords | Mode |
|---|---|
| calm, chill, soft, slow, ambient, intimate, acoustic | UNISON |
| orchestra, instruments, band, spread, separate, layers | ORCHESTRA |
| stereo, wide, left, right, image | STEREO |
| wave, ripple, roll, sweep, ocean, travel | WAVE |
| strobe, flash, rave, club, party, pulse, hype | STROBE |
| (no match) | UNISON |

Energy-spike heuristic: smooth `energy[]` with a 3 s moving average; `drop = argmax_t( mean(e[t..t+2]) − mean(e[t−4..t−1]) )` counts if the rise is > 0.2 (`meta.dropSec` wins when present). If a drop exists, or the prompt contains explode / drop / build / burst: scenes = `[{0, base}, {drop, STROBE if the prompt mentions strobe/flash/rave else WAVE}]`, plus `{drop + 16, base}` when `drop + 16 < durationSec`. Otherwise one scene at 0 — or two scenes alternating base / ORCHESTRA at `durationSec / 2` when the prompt mentions "change" or "then". Every scene's `note` is ≤ 40 chars ("calm", "build", "drop").

The mock server's `/vibe` is rules-only and fixed: `UNISON @0 → ORCHESTRA @50 % → WAVE {axis x, spanMs 240} @75 %`; `party-12.json` ships a plan `UNISON @0 → ORCHESTRA @30 → WAVE @45` for the strip.

Gate B6 check: 10/10 schema-valid on `synthetic-60s`; "calm then explode at the drop" → ≥2 scenes, a low-energy mode before the energy spike (`dropSec` 30), WAVE or STROBE after it; with the key unset the fallback returns a valid plan for the same prompt.

### Cost and model

`VIBE_MODEL` env var, default `claude-sonnet-5`; any Claude model id works unchanged. One call ≈ 1.5 K input + 400 output tokens: Sonnet 5 ≈ $0.007, Opus 5 ≈ $0.02, Haiku 4.5 ≈ $0.0035 — a whole demo day is cents. Needs a Console API key with credit in `ANTHROPIC_API_KEY`; a Max plan does not cover API calls, so check HackMIT sponsor credits. The demo works with no key via the fallback, and the cut list drops the LLM call before it drops anything the audience can hear.
