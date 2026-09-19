# HiveMusic — agent entry point

You are one of two coding agents building this repo in parallel during a hackathon. Read, in order:

1. `agents/SHARED-RULES.md` — ownership, the frozen contract, branches, commands, evidence.
2. Your brief: `agents/BACKEND-AGENT.md` (server + protocol + sync engine, Opus 5) or `agents/FRONTEND-AGENT.md` (Next.js UI, Sonnet 5).
3. `docs/00-context.md` → `docs/01-architecture.md` → `docs/02-protocol.md`, then the docs your brief lists.

Five hard rules:
- Edit only inside the directories your brief says you own. Requests for anything else go in `docs/PROTOCOL-REQUESTS.md`.
- `packages/protocol` and the public API in `packages/sync-client/src/index.ts` are the contract: additive changes only, backend-only, mock updated in the same commit.
- `bun run typecheck && bun run test` green before every commit that closes a gate. Never skip or disable a test.
- A gate is passed only when its check ran; evidence lives in `evidence/<agent>/`.
- Timing code uses `performance.now()`, never `Date.now()`; every number comes from `packages/protocol/src/constants.ts`.

Commands: `bun install`, `bun run fixtures`, `bun run typecheck`, `bun run test`, `bun run mock --scenario apps/web/mocks/scenarios/party-12.json`,
`bun run --cwd apps/server dev`, `bun run --cwd apps/web dev`. (Use `bun run --cwd <dir> <script>`; `bun --cwd <dir> run` does not run scripts.)
