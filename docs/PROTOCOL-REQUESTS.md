# Protocol change requests

Owner: both (either agent appends requests; the backend agent appends answers)

The contract — `packages/protocol` (`PROTOCOL_VERSION = 1`) and the public surface of `packages/sync-client/src/index.ts` — is frozen at IC0 and changes only additively after that. When a gate needs something the contract lacks, the requesting agent appends an entry here and moves on; it never patches the other tree. The backend agent answers here, makes the additive change, bumps `PROTOCOL_VERSION`, and updates `messages.ts`, [02-protocol.md](02-protocol.md) and the mock server in the **same commit**. This file is **append-only**: never edit or delete an earlier entry; add a new one that supersedes it. The format below is the one `agents/SHARED-RULES.md` §3 prescribes.

## Format

```
### R-<n> · <YYYY-MM-DD HH:MM> · from <frontend|backend> · status: open|accepted|declined|done
**Need:** one sentence. **Why:** which gate/screen is blocked. **Proposal:** the field/message/API shape.
**Answer (backend):** …  (commit: …)
```

Numbers are sequential from R-1. Status moves `open → accepted | declined → done` (done = landed on `main` with the version bump and the mock update). Timestamps are the agent's local time; the roadmap hour (`H+n`) may be added in brackets.

## Rules

1. Additive only: new optional fields, new message types, new constants, new routes, new sync-client methods or events. Removing or renaming anything needs a human decision.
2. One concern per entry.
3. A question about the existing contract is also an entry; the answer may just point to a section of [02-protocol.md](02-protocol.md) and needs no version bump.
4. A request that blocks a gate for more than an hour is answered first; other answers land by the next checkpoint.
5. Until an answer lands, the requester builds against the contract as it is and stubs the gap locally inside its own tree.
6. Merge conflicts in this file are resolved by keeping both sides in order.

## Entries

### R-0 · 2026-09-19 22:00 · from frontend · status: done  (illustrative example — not a real request)
**Need:** an `ERROR` code for a full room so Player · Join can say "this hive is full" instead of a generic failure. **Why:** F1 error states; `MAX_PLAYERS = 64` exists but no code names the rejection. **Proposal:** add `ROOM_FULL` to the `ERROR.code` list in 02-protocol.md §5; the server sends it in reply to `JOIN` when the room has `MAX_PLAYERS` connected players; no new fields.
**Answer (backend):** accepted — `ERROR.code` is an open string set, so no `PROTOCOL_VERSION` bump; `ROOM_FULL` added to §5 and to the mock's `JOIN` handler behind a scenario knob. (commit: example)

Real entries start at R-1 below this line.

### R-1 · 2026-09-19 · from server · status: open
**Need:** `dropSec` on `TrackLibraryEntrySchema` (`packages/protocol/src/rest.ts`). **Why:** gate B6 (Vibe Director) — `fixtures/tracks/<id>/meta.json` writes `dropSec` (see `fixtures/gen-synthetic.ts`) and docs/05-effect-modes.md says "`meta.dropSec` wins when present" for the energy-spike heuristic, but the wire schema for `/tracks` only carries `id, title, durationSec, stems, bpm, urls, energy, clickTimesSec, generated` — no `dropSec`. **Proposal:** add `dropSec: z.number().nonnegative().optional()` to `TrackLibraryEntrySchema`, populate it in the mock's `loadLibrary`, bump `PROTOCOL_VERSION`.
**Workaround (server):** `apps/server/src/vibe/track-meta.ts` reads `fixtures/tracks/<id>/meta.json` directly for `dropSec` server-side (never over the wire), so the rules fallback and the LLM prompt both get it without touching the contract. No frontend impact — the scene strip doesn't need `dropSec`.
