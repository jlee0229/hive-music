# HiveMusic — Effect Modes and the Vibe Director

Owner: backend agent (planner, pattern, vibe service, scene timer); frontend agent (mode chips, animations, vibe box, scene strip)

Five modes, all produced by the pure `plan(room)` in `@hive/protocol` as per-client assignments `{label, color, gainsDb, delayMs, compensationMs, pattern?, applyAtServerTime?}`. Switching modes never loads anything: every phone already holds all stems ([03](03-sync-engine.md)), so a switch is a set of gain ramps on the shared clock. A vibe prompt produces a `ScenePlan` the server plays back as timed mode switches. Message shapes: [02-protocol.md](02-protocol.md).

## Planner contract

- Input: `room` (uses `mode`, `track.stems`, `clients`). Output: an `assignment` for every client with `plays:true` and `connected:true`; `null` for hosts with `plays:false` and for disconnected clients (assumption on disconnected).
- Role for a client: `pinnedRole ?? stems[joinIndex % stems.length]`. `joinIndex` never changes, so joins never reshuffle anyone; only a mode change or a pin changes an existing client's assignment (the B5 tests: determinism, no reshuffle on join, pins win, non-playing host excluded, every mode covers every player).
- Silent stems use `OFF_DB = −60` (assumption; JSON cannot carry `−Infinity`); audible stems `0`.
- A non-stem track has one stem named `mix`; ORCHESTRA/STEREO degrade to everyone playing `mix` at 0 dB; WAVE/STROBE still apply delay/pattern.
- (assumption) In ORCHESTRA with fewer playing clients than stems, uncovered stems are folded onto players round-robin (`stem j → player j % N`) so every stem is heard; label and colour follow the client's primary role.
- `compensationMs` is copied from the client record into the assignment so the phone reads one object.
- `applyAtServerTime` is set only by the scene timer; manual changes apply immediately.
- Params are validated by zod with defaults; unknown keys are dropped.

## The five modes

### UNISON

| | |
|---|---|
| Listener hears | Every phone plays the whole mix; the room is +10·log10(N) dB louder than one phone and, under ~10–20 ms, sounds like one source |
| Planner rule | all stems `0 dB`; `delayMs 0`; no pattern; `label 'Unison'`; `color ROLE_COLORS.unison` |
| Sync needed | ≤10 ms target, ≤30 ms floor — the most demanding mode |
| Map fidelity | none (positions ignored) |
| Stems needed | any (works with `mix`) |
| Params | `{}` |

### ORCHESTRA

| | |
|---|---|
| Listener hears | Each phone is one instrument; walking the room walks through the band |
| Planner rule | role = `pinnedRole ?? stems[joinIndex % stems.length]`; role stem `0 dB`, others `OFF_DB`; `delayMs 0`; `label` = role name; `color ROLE_COLORS[role]` |
| Sync needed | ≤20 ms (error reads as a loose band, not smear); ≤10 still the target |
| Map fidelity | none for audio; roles show as dot colours; tap-to-cycle sends `ASSIGN` |
| Stems needed | ≥2 real stems (else degrades to UNISON gains) |
| Params | `{}` |

### STEREO (zone-based stem grouping)

| | |
|---|---|
| Listener hears | Rhythm section on the left of the room, vocals and the rest on the right — a wide image built from mono stems |
| Planner rule | zone = `position.x < 0.5 ? 'left' : 'right'`; unplaced → by `joinIndex` parity (assumption); left: `drums 0, bass 0, vocals OFF_DB, other OFF_DB`; right: the inverse; `delayMs 0`; `label 'Left' / 'Right'`; colour left = `ROLE_COLORS.drums`, right = `ROLE_COLORS.vocals` (assumption) |
| Sync needed | ≤20 ms |
| Map fidelity | coarse: which half of the room a phone is in |
| Stems needed | 4 stems; with 2 stems, one per zone; with `mix`, degrades to UNISON |
| Params | `{}`; a true L/R split from a stereo mix asset is stretch |

### WAVE

| | |
|---|---|
| Listener hears | The same music rolling across the room: the far side plays up to `spanMs` later, so every beat sweeps from one wall to the other |
| Planner rule | all stems `0 dB`; `delayMs = round(spanMs × projection)`, `projection = axis === 'x' ? position.x : position.y` (unplaced → 0.5, assumption); `pattern {kind:'wave', periodMs: 2000, phaseMs: delayMs, duty: 0.2}` drives the screen sweep only (assumption on values; the audio multiplier for `wave` is 1 — the delay is the audible effect); `label 'Wave'`; `color ROLE_COLORS.unison` |
| Sync needed | ≤30 ms (deliberate 0–300 ms delays dwarf it) |
| Map fidelity | real: delay is a function of position; a misplaced dot is an audible glitch in the sweep |
| Stems needed | any |
| Params | `{ axis: 'x' \| 'y', spanMs: 0–300 }`; defaults `axis 'x'`, `spanMs 200` (assumption) |

### STROBE

| | |
|---|---|
| Listener hears | The music gated on and off in groups, ping-ponging across the room in time; screens flash with the gate |
| Planner rule | all stems `0 dB`; `delayMs 0`; `pattern {kind:'strobe', periodMs, phaseMs: (joinIndex % groups) × periodMs / groups, duty}`; `label 'Strobe ' + (group + 1)`; `color ROLE_COLORS.unison` |
| Sync needed | ≤30 ms (6 % of a 500 ms period) |
| Map fidelity | none in v1 (groups by `joinIndex`); position-based phase is a later variant |
| Stems needed | any |
| Params | `{ periodMs: 500, duty: 0.5, groups: 2 }` defaults (assumption); ranges as in the schema below |

`evaluatePattern(pattern, trackTimeMs)` in `packages/protocol/src/pattern.ts`:

```
t  = ((trackTimeMs − phaseMs) mod periodMs + periodMs) mod periodMs
on = t < (duty ?? 0.5) · periodMs
→ on ? 1 : 0          // strobe: audio gain multiplier + screen; wave: screen only (assumption)
```

Deterministic, evaluated **client-side on the shared clock**: the engine schedules gain automation one period ahead (5 ms edge ramps), the UI evaluates it per frame for the screen. No per-tick messages ever leave the server; a 20-phone STROBE costs zero bandwidth.

## ROLE_COLORS and health colours

| Key | Hex | Used for |
|---|---|---|
| `drums` | `#F59E0B` amber | ORCHESTRA drums; STEREO left |
| `bass` | `#8B5CF6` violet | ORCHESTRA bass |
| `vocals` | `#22D3EE` cyan | ORCHESTRA vocals; STEREO right |
| `other` | `#34D399` green | ORCHESTRA other |
| `unison` | `#F8FAFC` white | UNISON, WAVE, STROBE |
| `host` | hollow ring (stroke only, no fill) | the host dot on the map; a host with `plays:true` is a hollow ring in its role colour |

| Health | Hex | Rule (`healthLevel(h)`) |
|---|---|---|
| `good` | `#22C55E` | `syncErrMs ≤ 5` and `lastSeen ≤ 5 s` |
| `warn` | `#EAB308` | `syncErrMs ≤ 20` and `lastSeen ≤ 5 s` |
| `bad` | `#EF4444` | `syncErrMs > 20` and `lastSeen ≤ 5 s` |
| `unknown` | `#64748B` | `lastSeen > 5 s`, or no status yet |

The map draws health as a ring around the dot; the fill is the role colour. Both tables live in `packages/protocol/src/constants.ts`; the UI legend imports them and never copies the hex values.

## Vibe Director

The host types a vibe; one structured-output Claude call returns a validated `ScenePlan`; the server plays it back on the timeline. Gate B6.

### ScenePlan schema (`packages/protocol/src/scene.ts`)

```ts
import { z } from 'zod';

export const ModeKind = z.enum(['UNISON', 'ORCHESTRA', 'STEREO', 'WAVE', 'STROBE']);

export const ModeParams = z.object({
  axis: z.enum(['x', 'y']).optional(),                    // WAVE
  spanMs: z.number().min(0).max(300).optional(),          // WAVE
  periodMs: z.number().min(100).max(4000).optional(),     // STROBE
  duty: z.number().min(0.05).max(0.95).optional(),        // STROBE
  groups: z.number().int().min(1).max(8).optional(),      // STROBE
});

export const Scene = z.object({
  atTrackSec: z.number().min(0),
  mode: ModeKind,
  params: ModeParams,
  note: z.string().max(80),                               // shown on the scene strip
});

export const ScenePlanSchema = z.object({
  prompt: z.string(),
  scenes: z.array(Scene).min(1).max(12),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;
```

Server post-validation (assumption): sort by `atTrackSec`; drop scenes at or beyond `durationSec`; if the first scene is not at 0, prepend `{atTrackSec: 0, mode: 'UNISON', params: {}, note: 'start'}`; merge scenes closer than 2 s (keep the later one).

### Inputs to the call

| Input | Source |
|---|---|
| vibe text | `POST /rooms/:code/vibe {prompt}`; trimmed, ≤200 chars (assumption) |
| track meta | `fixtures/<trackId>/meta.json`: `title`, `durationSec`, `stems[]`, `energy[]` (one value per second, 0..1) |
| player count | `count(clients where plays && connected)` |
| current mode | `room.mode` |

### System prompt outline (`apps/server/src/vibe/prompt.ts`)

1. Role: "You are the lighting-and-sound director for a crowd of N phones playing one track together."
2. The five modes, one line each: what they feel like and when they work (ORCHESTRA/STEREO need ≥2 stems; WAVE/STROBE are high-energy; UNISON is the calm default).
3. Parameter ranges (as in the schema) and their defaults.
4. The energy curve, downsampled to ≤60 numbers, plus the timestamps of the three largest rises.
5. Rules: first scene at 0; at most one switch per 8 s; match energy (low → UNISON/ORCHESTRA, rises → WAVE, peaks → STROBE); ≤10-word `note` per scene; never more scenes than `durationSec / 8`.
6. Output only the plan — the format is enforced by `output_config`.

### The call (`apps/server/src/vibe/director.ts`)

```ts
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ScenePlanSchema } from '@hive/protocol';
import { rulesFallback } from './rules';

const client = new Anthropic();                       // reads ANTHROPIC_API_KEY

export async function directScene(vibe: string, meta: TrackMeta, playerCount: number, currentMode: string) {
  if (!process.env.ANTHROPIC_API_KEY) return rulesFallback(vibe, meta);
  try {
    const response = await client.messages.parse(
      {
        model: process.env.VIBE_MODEL ?? 'claude-sonnet-5',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(vibe, meta, playerCount, currentMode) }],
        output_config: { format: zodOutputFormat(ScenePlanSchema) },
      },
      { timeout: 5_000, maxRetries: 0 },              // 5 s budget, no silent retries
    );
    if (response.stop_reason === 'refusal' || response.parsed_output === null) return rulesFallback(vibe, meta);
    return postValidate(response.parsed_output, meta);
  } catch {
    return rulesFallback(vibe, meta);
  }
}
```

Fallback triggers: no `ANTHROPIC_API_KEY`, `parsed_output === null`, `stop_reason === 'refusal'`, any thrown error, or the 5 s timeout. The response to the host is the same `{scenePlan}` either way; `scenePlan.prompt` is echoed so the strip can show it.

### Scene timer (`apps/server/src/scene-timer.ts`)

- On plan accepted: `room.scenePlan = plan`; broadcast `ROOM_STATE`. If playing, scene 0 (`atTrackSec: 0`) applies immediately with no `applyAtServerTime`.
- While `transport.state === 'playing'`, arm one timer for the next scene with `atTrackSec > trackTimeSec`: fire at `serverTime = serverTimeAtTrackZero + atTrackSec·1000 − LEAD_MS` (`LEAD_MS = 600`). On fire: `room.mode = {kind: scene.mode, params: scene.params}`, re-plan, set every `assignment.applyAtServerTime = serverTimeAtTrackZero + atTrackSec·1000`, broadcast, arm the next.
- Timers derive from `transport`: PAUSE cancels; PLAY/SEEK re-arms for scenes ahead of the new position, and the latest scene at or before the new position becomes the current mode immediately.
- **Manual override:** any `SET_MODE` sets `scenePlan = null`, cancels the timer and applies immediately. The scene strip empties; the host can submit a new vibe.
- The client ramps gains at `ctxAt(applyAtServerTime)` ([03](03-sync-engine.md)); all phones switch within the clock budget of each other.

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

Energy-spike heuristic: smooth `energy[]` with a 3 s moving average; `drop = argmax_t( mean(e[t..t+2]) − mean(e[t−4..t−1]) )` counts if the rise is > 0.2. If a drop exists, or the prompt contains explode / drop / build / burst: scenes = `[{0, base}, {drop, STROBE if the prompt mentions strobe/flash/rave else WAVE}]`, plus `{drop + 16, base}` when `drop + 16 < durationSec`. Otherwise one scene at 0 — or two scenes alternating base / ORCHESTRA at `durationSec / 2` when the prompt mentions "change" or "then".

Gate B6 check: 10/10 schema-valid on `synthetic-60s`; "calm then explode at the drop" → ≥2 scenes, a low-energy mode before the energy spike, WAVE or STROBE after it; with the key unset the fallback returns a valid plan for the same prompt.

### Cost and model

`VIBE_MODEL` env var, default `claude-sonnet-5`; any Claude model id works unchanged. One call ≈ 1.5 K input + 400 output tokens: Sonnet 5 ≈ $0.007, Opus 5 ≈ $0.02, Haiku 4.5 ≈ $0.0035 — a whole demo day is cents. Needs a Console API key with credit in `ANTHROPIC_API_KEY`; a Max plan does not cover API calls, so check HackMIT sponsor credits. The demo works with no key via the fallback, and the cut list drops the LLM call before it drops anything the audience can hear.
