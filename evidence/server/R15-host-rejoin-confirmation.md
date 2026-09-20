# R-15 — host re-JOIN-with-current-key promotion: confirmation, not a fix

A same-day finding (frontend's PR #10, filed independently as its own R-15) claimed `join()` only
consults `wantsHost` for a brand-new `clientId`, so a reconnect with an existing, already-demoted
`clientId` stays demoted even once it presents the room's current `hostKey`. Checked both copies:

## `apps/server/src/rooms.ts` — already correct

`join()`'s `existing` branch (`rooms.ts:349-351`) already re-derives both fields from `wantsHost` on
every JOIN, not just at record creation:

```ts
const wantsHost = msg.kind === "host" && (msg.hostKey === this.hostKey || existing?.kind === "host" || this.room.hostClientIds.length === 0);
const rec: ClientRecord = existing
  ? { ...existing, connected: true, name: msg.name ?? existing.name, device, kind: wantsHost ? "host" : existing.kind, plays: wantsHost ? msg.plays : existing.plays }
  : { ... };
```

This landed with the P0-2 fix earlier this session (merged via PR #6/#9), specifically to let a
demoted host recover once it presents the real key — see the comment directly above it in
`rooms.ts` and `docs/PROTOCOL-REQUESTS.md`'s R-11/R-14 entries.

`apps/server/src/__tests__/p0-fixes.test.ts` already had a direct test for the promotion path
("an existing player record is promoted to host once it presents the room's real hostKey"). Added
one more matching the exact repro requested — destroy/recreate the room, let the original host land
as a demoted player behind a new host, then re-JOIN with the current key:

```
$ bun run --cwd apps/server test src/__tests__/p0-fixes.test.ts
bun test v1.3.11 (af24e281)

 7 pass
 0 fail
 32 expect() calls
Ran 7 tests across 1 file. [103.00ms]
```

New test additionally asserts `hostClientIds` gains no duplicate entry and the promoted record's
`joinIndex` is unchanged — the same record is promoted in place, not a second one spliced in.

Root `bun run typecheck && bun run test`: green, 58 server tests (was 57).

## `packages/protocol/src/mock-server.ts` — bug confirmed, not mine to fix

Lines 231-233:

```ts
const wantsHost = msg.kind === "host" && (msg.hostKey === hostKey || existing?.kind === "host");
const rec: ClientRecord = existing
  ? { ...existing, connected: true, name: msg.name ?? existing.name, device: msg.device }
  : { ... };
```

The `existing` branch never reads `wantsHost` — a demoted client's `kind`/`plays` never change on a
later JOIN regardless of key. Also missing `apps/server`'s `hostClientIds.length === 0` clause for a
freshly-respawned room nobody holds yet. Filed as `docs/PROTOCOL-REQUESTS.md` R-15 with a proposed
fix (port `apps/server/rooms.ts:349-351`'s `existing` branch verbatim) for the engine agent, since
`packages/protocol` is outside this agent's ownership.

## Conclusion

`apps/server` was already correct — **already correct, test added.**
