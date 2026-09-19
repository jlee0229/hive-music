# B6 — Vibe Director

`ANTHROPIC_API_KEY` is **unset** in this environment, so the LLM path (`apps/server/src/vibe/director.ts`'s
`client.messages.parse` call) is exercised only up to the `if (!process.env.ANTHROPIC_API_KEY) return
wrap(rulesFallback(...), "rules")` early return — the actual Anthropic API call is untested here. The
10/10-valid-on-the-LLM-path check from the brief cannot be run without a Console key with credit; the human
should re-run `bun run --cwd apps/server test src/__tests__/vibe.test.ts` with `ANTHROPIC_API_KEY` set to
confirm the LLM path (see `docs/09-deploy.md` and the demo-day checklist in `docs/08-roadmap.md`).

Everything that does not need a key is covered by `apps/server/src/__tests__/vibe.test.ts` (6 tests, 28
assertions, all green):

```
$ bun run --cwd apps/server test src/__tests__/vibe.test.ts
bun test v1.3.11 (af24e281)

(pass) vibe rules fallback (unit) > 10/10 prompts produce a schema-valid plan on synthetic-60s
(pass) vibe rules fallback (unit) > "calm, then explode at the drop" is calm first, then WAVE/STROBE at dropSec
(pass) vibe rules fallback (unit) > strobe/flash/rave keywords pick STROBE at the drop instead of WAVE
(pass) vibe rules fallback (unit) > normalizeScenes prepends UNISON@0 when the first scene isn't at 0, and merges scenes closer than 2s
(pass) directScene (no ANTHROPIC_API_KEY in this environment) > falls back to rules and returns a schema-valid plan
(pass) POST /rooms/:code/vibe (HTTP integration, key unset) > returns a schema-valid, calm-first plan with the drop scene at dropSec

 6 pass
 0 fail
 28 expect() calls
Ran 6 tests across 1 file. [721.00ms]
```

Covers the brief's check for the key-unset half:

- **10/10 schema-valid** — 10 varied prompts (keyword matches for every mode, "just vibe" with no keyword,
  a build/change prompt, and the demo prompt) all produce a plan that parses against `ScenePlanSchema`
  (ascending `atTrackSec`, first scene at 0, every field in range).
- **Calm first, WAVE/STROBE at `dropSec`** — `synthetic-60s`'s `meta.json` has `dropSec: 30` (from
  `fixtures/gen-synthetic.ts`); `readDropSec` (`apps/server/src/vibe/track-meta.ts`) reads it directly since
  the wire schema doesn't carry it yet (`docs/PROTOCOL-REQUESTS.md` R-1). "calm, then explode at the drop"
  → `[{0, UNISON, "calm"}, {30, WAVE, "drop"}, {46, UNISON, "settle"}]`; a prompt naming
  strobe/flash/rave picks STROBE at the drop instead.
- **Fallback with the key unset returns a valid plan for the same prompt** — `directScene()` unit test and
  the full HTTP round-trip (`POST /rooms/:code/vibe`) both confirm `source: "rules"` and a schema-valid
  `scenePlan`, and that the room broadcasts it in the next `ROOM_STATE`.

Root `bun run typecheck && bun run test`: green, 43 tests total.
