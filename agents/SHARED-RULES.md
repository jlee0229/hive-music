# Shared rules for the two build agents

Two agents build HiveMusic in parallel during HackMIT (≈18 hours). These rules exist so they never block each other.
Read this first, then your brief: [BACKEND-AGENT.md](BACKEND-AGENT.md) or [FRONTEND-AGENT.md](FRONTEND-AGENT.md).

## 1. Ownership is by directory, and it is absolute

| path | owner | the other agent may… |
|---|---|---|
| `apps/server/**` | backend | read |
| `packages/protocol/**` | backend | read, import, **request** changes |
| `packages/sync-client/**` | backend | read, import, **request** changes |
| `fixtures/**`, `infra/**` | backend | read, run `bun run fixtures` |
| `apps/web/**` (incl. `apps/web/mocks/scenarios/`) | frontend | read |
| `docs/**` | setup (already written) | **append** to `docs/PROTOCOL-REQUESTS.md`; update **your own** rows in `docs/08-roadmap.md` status table |
| `agents/<YOUR>-AGENT.md` | you | update your gate table only |
| `evidence/<your-agent>/**` | you | – |
| root config, `.github/**`, `README.md`, `CLAUDE.md` | setup | propose in `PROTOCOL-REQUESTS.md`; the human decides |

Never edit a file outside your tree. If you need something there, write the request (§3) and keep going.

## 2. The contract is frozen at IC0 and additive-only after

`packages/protocol` (`PROTOCOL_VERSION = 1`) and the public surface of `packages/sync-client/src/index.ts` are the contract.
Both agents build against them from minute one. After IC0:

- Only the backend agent edits them, and only **additively** (new optional fields, new message types, new constants). Removing or
  renaming anything requires a human decision.
- Every change bumps `PROTOCOL_VERSION`, updates `docs/02-protocol.md` (the schema test enforces the message tables), updates the
  mock server in the **same commit**, and is announced with an entry in `docs/PROTOCOL-REQUESTS.md`.
- The mock server and the real server pass the same schema tests. If the mock and the real server ever disagree, the mock is wrong
  and the backend agent fixes it immediately, because the frontend is building against it.

## 3. Asking for something: `docs/PROTOCOL-REQUESTS.md`

Append-only. One entry per ask:

```
### R-<n> · <YYYY-MM-DD HH:MM> · from <frontend|backend> · status: open|accepted|declined|done
**Need:** one sentence. **Why:** which gate/screen is blocked. **Proposal:** the field/message/API shape.
**Answer (backend):** …  (commit: …)
```

The requester moves on to the next task while waiting. Never patch around the gap inside the other tree.

## 4. Imports

- `apps/web` imports only `@hive/protocol` and `@hive/sync-client`. Never from `apps/server`, never a raw `WebSocket`/`AudioContext`
  outside the sync-client package.
- `apps/server` imports `@hive/protocol` only. Nothing imports from `apps/*`.
- New third-party dependencies: allowed inside your own package; note them in your gate table row.

## 5. Branches and merging

- Work on `agent/backend` or `agent/frontend`, branched from `main` at IC0. Commit small and often with the gate id in the message (`B3: transport scheduler`).
- Before every gate: `git fetch origin main && git rebase origin/main` (your own branch only), then `bun run typecheck && bun test` at the root must be green.
- At each integration checkpoint (IC1–IC3, rehearsal) open a PR to `main`; the human merges. Merge conflicts are only possible in
  `docs/PROTOCOL-REQUESTS.md` and the roadmap status table, both append-only → keep both sides.
- Never rewrite the other agent's branch. Never force-push `main`.

## 6. Commands (Bun 1.3; note the `bun run --cwd <dir> <script>` form — `bun --cwd <dir> run` does NOT work)

```
bun install                                   # once; hoisted linker is configured in bunfig.toml
bun run fixtures                              # writes fixtures/tracks/synthetic-60s/*.wav (gitignored) + meta.json
bun run typecheck && bun run test             # root gate (turbo runs every package)
bun run mock --scenario apps/web/mocks/scenarios/party-12.json   # mock server on :8080 (ws://localhost:8080/ws)
bun run --cwd apps/server dev                 # real server on :8080 (backend)
bun run --cwd apps/web dev                    # Next.js on :3000 (frontend)
bun run --cwd packages/protocol test          # one package
```

## 7. Gates and evidence

Every gate in your brief has a check. When it passes, put the evidence in `evidence/<agent>/<gate>-<short>.{png,md,txt,mp4}`
(WAV/MP4 are gitignored: reference them by a one-line `.md` with the measurement) and flip the row in your brief's gate table to
✅ with the evidence path and commit hash. A gate is not passed because the code exists; it is passed because the check ran.

Rules that are never relaxed: no skipping, disabling or quarantining a test to get green; no `Date.now()` for timing (use
`performance.now()`); no service worker; the numbers in `packages/protocol/src/constants.ts` are the numbers in the docs.

## 8. Stop conditions (write the request, move on)

- The contract lacks a field, message or sync-client method you need.
- A gate's check needs hardware or a person you do not have (a second phone, a quiet room): do the automated half, write the manual
  checklist into the evidence file, mark the row 🟡 "needs human", continue.
- A dependency cannot be installed through the proxy.

## 9. Checkpoints (hours from agent start) and the cut list

| when | joint exit criterion |
|---|---|
| IC0 (done) | protocol + planner + mock + stub client + sync-client API + fixtures on `main` |
| IC1 ≈ H+6 | frontend Join/Ready on two phones against the **real** server: `WELCOME`, sync numbers, `AUDIO_READY` |
| IC2 ≈ H+11 | three phones in unison from the host phone; nudge works; measured < 10 ms |
| IC3 ≈ H+15 | Orchestra + one more mode, Hive Map placement, a vibe plan running |
| Rehearsal ≈ H+17 | the 3-minute demo script in `docs/08-roadmap.md`, twice, on the venue Wi-Fi |

Cut list, in order, when behind: B9 (upload/crowd table/slewing) → drag-to-reassign polish → B8/F7 tuning moment (keep Tier 1) →
STROBE → the vibe LLM call (keep the rules fallback) → STEREO.
