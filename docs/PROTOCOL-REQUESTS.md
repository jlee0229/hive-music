# Protocol change requests

Owner: both (the frontend agent appends requests; the backend agent appends answers)

The contract in [02-protocol.md](02-protocol.md) and `packages/protocol` is frozen at IC0 and changes only additively after that. When a frontend gate needs something the contract lacks, the frontend agent appends a request here and moves on — it never patches `packages/protocol`. The backend agent answers here, bumps `PROTOCOL_VERSION`, and updates `messages.ts`, `02-protocol.md` and the mock server in the same commit. This file is **append-only**: never edit or delete an earlier entry; add a new one that supersedes it.

## Format

Entries are numbered `PR-001`, `PR-002`, … in order of appearance. Status ∈ `open` · `accepted` · `accepted with changes` · `rejected` · `superseded by PR-nnn`. Copy this template:

```
## PR-nnn — <short title>
- Requested by: frontend agent | backend agent
- Gate: <the F-gate or B-gate that needs it>
- Status: open
- Request: <what is missing — the exact message, field or route wanted, and why the current contract cannot express it>
- Proposed shape: <TypeScript or JSON of the additive change>
- Answer (backend): <accepted as proposed | accepted with changes: … | rejected because …>
- Landed in: PROTOCOL_VERSION <n>, commit <sha>, mock updated: yes | no
```

## Rules

1. Additive only: new optional fields, new message types, new routes. Never rename or remove.
2. One concern per entry.
3. A question about the existing contract is also an entry; the answer may just point to a section of [02-protocol.md](02-protocol.md) and needs no version bump.
4. A request that blocks a gate for more than an hour is answered first; other answers land by the next checkpoint.
5. Until an answer lands, the frontend builds against the mock as it is and stubs the gap locally inside `apps/web`.

## Entries

## PR-000 — Example (illustrative): own-nudge from the player screen
- Requested by: frontend agent
- Gate: F3
- Status: accepted with changes
- Request: Player · Playing has an "I sound early ↔ late" slider. The frozen sync-client API exposes nudge only as `host.nudge(clientId, nudgeMs)` and the contract does not say whether the server accepts `NUDGE` from a non-host socket.
- Proposed shape: no wire change; document that `NUDGE {clientId, nudgeMs}` is accepted from a non-host connection when `clientId === sender.clientId`, and that players call `host.nudge(me.id, nudgeMs)`.
- Answer (backend): accepted with changes — same wire shape; a non-host `NUDGE` for a foreign `clientId` is answered with `ERROR {code:'FORBIDDEN'}`. Clarification only; no `PROTOCOL_VERSION` bump.
- Landed in: PROTOCOL_VERSION 1, commit <pending>, mock updated: yes

(PR-000 is a worked example matching the assumption in [03-sync-engine.md](03-sync-engine.md); the backend agent confirms or replaces it at B1. Real entries start at PR-001.)
