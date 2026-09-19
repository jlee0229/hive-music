# HiveMusic — Effect Modes and the Vibe Director

Owner: backend agent (planner, pattern, vibe service, scene timer); frontend agent (mode chips, animations, vibe box, scene strip)

Five modes, all produced by the pure `plan(room)` in `packages/protocol/src/planner.ts` as per-client assignments `{label, role, color, gainsDb, delayMs, compensationMs, pattern, applyAtServerTime}`. Switching modes never loads anything: every phone already holds all stems ([03](03-sync-engine.md)), so a switch is a set of gain ramps on the shared clock. A vibe prompt produces a `ScenePlan` the server plays back as timed mode switches. Message shapes: [02-protocol.md](02-protocol.md).

## Planner contract (as implemented)

- Input: `room` (uses `mode`, `track.stems`, `clients`). Output: an `assignment` for every client with `plays:true` — connected or not, so a phone that drops for a minute keeps its slot — and `null` for hosts with `plays:false`.
- Role for a client: `stemForClient` = `pinnedRole` if it is one of the track's stems, else `roles[joinIndex % roles.length]` where `roles` = `STEMS` ∩ `track.stems` in canonical order (`drums, bass, vocals, other`). `joinIndex` never changes, so joins never reshuffle anyone; only a mode change or a pin changes an existing client's assignment (B5 tests: determinism, no reshuffle on join, pins win, non-playing host excluded, every mode covers every speaker).
- Silent stems are `SILENT_DB = −60`; audible stems `0` plus the optional per-stem trim `mode.params.stemGainsDb[stem]` (−60..12), clamped at −60.
- A non-stem track has one stem named `mix`; ORCHESTRA/STEREO collapse to unison gains for it; WAVE/STROBE still apply delay/pattern.
- With fewer speakers than stems in ORCHESTRA, some stems go unheard (the planner does not fold stems); the host fixes it with pins or by switching to UNISON. A folding rule is a candidate `PROTOCOL-REQUESTS` entry, not a v1 behaviour.
- `compensationMs` is copied from the client record into the assignment so the phone reads one object.
- `applyAtServerTime` is set only by the scene timer (`withAssignments(room, boundary)`); manual changes carry `null` and apply immediately.
- Params are validated by `ModeParamsSchema` (unknown keys stripped); `resolveModeParams` fills defaults `axis 'x'`, `spanMs 240`, `periodMs 500`, `duty 0.5`, `groups 2`.

## The five modes

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
| Listener hears | Each phone is one instrument; walking the room walks through the band |
| Planner rule | stem = `stemForClient(c, roles)`; that stem `0 dB`, others `SILENT_DB`; `delayMs 0`; `pattern null`; `label` = stem name; `role` = stem; `color ROLE_COLORS[stem]`; no real stems → unison gains |
| Sync needed | ≤20 ms (error reads as a loose band, not smear); ≤10 still the target |
| Map fidelity | none for audio; roles show as dot colours; tap-to-cycle sends `ASSIGN` |
| Stems needed | ≥2 real stems (else collapses to UNISON gains) |
| Params | `{ stemGainsDb? }` |

### STEREO (zone-based stem grouping)

| | |
|---|---|
| Listener hears | Rhythm section on the left of the room, vocals and the rest on the right — a wide image built from mono stems |
| Planner rule | `left = position ? position.x < 0.5 : joinIndex % 2 === 0`; left: `drums 0, bass 0, vocals −60, other −60`; right: the inverse; if the track lacks the zone's stems, all stems; `delayMs 0`; `pattern null`; `label 'left' / 'right'`; `role 'drums' / 'vocals'` (so left is amber, right is cyan) |
| Sync needed | ≤20 ms |
| Map fidelity | coarse: which half of the room a phone is in (`x < 0.5`) |
| Stems needed | 4 stems; with 2 stems, one per zone; with `mix`, collapses to UNISON |
| Params | `{ stemGainsDb? }`; a true L/R split from a stereo mix asset is stretch |

### WAVE

| | |
|---|---|
| Listener hears | The same music rolling across the room: the far side plays up to `spanMs` later, and a slow swell (2 s period) travels along the same axis, so every beat and every swell sweeps from one wall to the other |
| Planner rule | all stems `0 dB`; `proj = projection(c, axis)` (`position[axis]`, unplaced → 0.5); `delayMs = round(spanMs × proj)`; `pattern {kind:'wave', periodMs: WAVE_SWELL_PERIOD_MS (2000), phaseMs: round(proj × 2000)}`; `label 'wave'`; `role 'unison'`; `color ROLE_COLORS.unison` |
| Sync needed | ≤30 ms (the deliberate 0–300 ms delays and the 2 s swell dwarf it) |
| Map fidelity | real: delay and swell phase are functions of position; a misplaced dot is an audible glitch in the sweep |
| Stems needed | any |
| Params | `{ axis: 'x' \| 'y', spanMs: 0–300 }`; defaults `axis 'x'`, `spanMs 240` (`WAVE_DEFAULT_SPAN_MS`) |

### STROBE

| | |
|---|---|
| Listener hears | The music gated on and off in groups, ping-ponging across the room in time; screens flash with the gate in the group's colour |
| Planner rule | all stems `0 dB`; `delayMs 0`; `group = joinIndex % groups`; `pattern {kind:'strobe', periodMs, phaseMs: round(group / groups × periodMs), duty, rampMs: 10}`; `label 'strobe ' + (group + 1)`; `role STEMS[group % 4]` (group 1 amber, 2 violet, 3 cyan, 4 green); `color ROLE_COLORS[role]` |
| Sync needed | ≤30 ms (6 % of a 500 ms period) |
| Map fidelity | none in v1 (groups by `joinIndex`); position-based phase is a later variant |
| Stems needed | any |
| Params | `{ periodMs: 100–8000, duty: 0.05–1, groups: 1–8 }`; defaults `500 / 0.5 / 2` |

`evaluatePattern(pattern, trackTimeMs)` in `packages/protocol/src/pattern.ts` returns a gain multiplier in `[0, 1]` (`null` pattern → 1):

```
t = wrap(trackTimeMs − phaseMs, periodMs)                  // ((t % p) + p) % p
wave   → 0.5 − 0.5 · cos(2π · t / periodMs)                // raised-cosine swell: 0 at the phase origin, 1 half a period later
strobe → on = (duty ?? 0.5) · periodMs; ramp = min(rampMs ?? 10, on / 2)
         t < ramp → t / ramp;  t < on − ramp → 1;  t < on → (on − t) / ramp;  else 0
```

Deterministic, evaluated **client-side on the shared clock**: the engine schedules the multiplier as gain automation one period ahead, the UI evaluates it per frame for the screen (WAVE: dots brighten in sweep order; STROBE: dots blink in groups). No per-tick messages ever leave the server; a 60-phone STROBE costs zero bandwidth.

## ROLE_COLORS and health colours

`constants.ts` is the source; the UI imports it and never copies hex values.

| Key | Hex | Used for |
|---|---|---|
| `drums` | `#F59E0B` amber | ORCHESTRA drums; STEREO left; STROBE group 1 |
| `bass` | `#8B5CF6` violet | ORCHESTRA bass; STROBE group 2 |
| `vocals` | `#22D3EE` cyan | ORCHESTRA vocals; STEREO right; STROBE group 3 |
| `other` | `#34D399` green | ORCHESTRA other; STROBE group 4 |
| `unison` | `#F8FAFC` white | UNISON, WAVE |
| host | hollow ring, stroke `HOST_RING_COLOR #F1F5F9`, no fill | the host dot on the map; a host with `plays:true` is a hollow ring in its role colour |

| Health | Hex | `healthLevel(h, nowServerTime)` |
|---|---|---|
| `good` | `#22C55E` | `syncErrMs ≤ 5` and seen within 5 s |
| `warn` | `#EAB308` | `syncErrMs ≤ 20` and seen within 5 s |
| `bad` | `#EF4444` | `syncErrMs > 20`, **or** `lastSeenServerTime` older than 5 s |
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
2. The five modes, one line each: what they feel like and when they work (ORCHESTRA/STEREO need ≥2 stems; WAVE/STROBE are high-energy; UNISON is the calm default).
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

- On plan accepted: `room.scenePlan = plan`; broadcast `ROOM_STATE`. If playing, the scene at or before the current position applies immediately with `applyAtServerTime: null`.
- While `transport.state === 'playing'`, arm one timer for the next scene with `atTrackSec > trackTimeSec`: fire at `serverTime = serverTimeAtTrackZero + atTrackSec·1000 − LEAD_MS` (`LEAD_MS = 600`). On fire: `room.mode = {kind: scene.mode, params: scene.params}`, `room = withAssignments(room, serverTimeAtTrackZero + atTrackSec·1000)`, broadcast, arm the next.
- Timers derive from `transport`: PAUSE cancels; PLAY/SEEK re-arms for scenes ahead of the new position, and the latest scene at or before the new position becomes the current mode immediately.
- **Manual override:** any `SET_MODE` sets `scenePlan = null`, cancels the timer and applies immediately (the mock does the same). The scene strip empties; the host can submit a new vibe.
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
