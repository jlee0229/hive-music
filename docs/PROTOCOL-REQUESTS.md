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

### R-1 · 2026-09-19 23:05 · from backend · status: done
**Need:** the exact `ERROR.code` set the **real** server emits, and the one behavioural difference from the mock that the join screens will notice. **Why:** B1 is done and the frontend switches to `apps/server` at IC1; error states (F1) should match what actually arrives. **Proposal:** no wire change, no `PROTOCOL_VERSION` bump — `ERROR.code` is an open string set (`z.string()`), so this is a clarification only.
**Answer (backend):** the real server sends exactly these codes, and nothing else:

| code | when | what the UI should do |
|---|---|---|
| `BAD_MESSAGE` | a frame failed `ClientMessageSchema` | never expected from `@hive/sync-client`; log it |
| `NO_ROOM` | `JOIN` for a code with no room | "this hive does not exist" — the room must be created with `POST /rooms` first (the mock pre-creates one; the real server does not) |
| `NOT_JOINED` | any message other than `JOIN`/`NTP_REQUEST` before `WELCOME` | never expected; the engine sends `JOIN` first |
| `NOT_HOST` | a player sent `SET_TRACK`, `TRANSPORT`, `SET_MODE`, `ASSIGN`, `SET_POSITION`, `KICK`, `SET_PLAYS` or `CALIBRATION_START` | ignore; the socket stays open |
| `FORBIDDEN` | a player sent `NUDGE` for someone else's id; a non-reference sent `CALIBRATION_REPORT`; a host tried to `KICK` itself | ignore |
| `NO_TRACK` | `TRANSPORT` with no track loaded, or `SET_TRACK` with an id the library does not have | "pick a track first" |
| `ROOM_FULL` | `JOIN` from a new client when `MAX_PLAYERS` (64) players are **connected** | "this hive is full" (as accepted in R-0) |
| `KICKED` | the host removed this client | close for good; `room = null` (the engine already does this) |

Two notes that are not errors: a `JOIN` claiming `kind: "host"` with a wrong or missing `hostKey` is **demoted to a player** rather than refused (`WELCOME.isHost = false`), and a `JOIN` whose `protocolVersion` differs from the server's is **accepted** — `WELCOME.protocolVersion` is the server's, and comparing it is how a stale bundle knows to reload. (commit: B1, mock updated: not needed — the mock already emits `BAD_MESSAGE`/`NO_ROOM`/`NOT_HOST`/`NO_TRACK`/`KICKED` and the additional codes only narrow cases the mock silently ignores.)
