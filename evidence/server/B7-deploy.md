# B7 — Deployable

No Fly credentials and no Docker daemon in this environment (`docker info` fails: no `/var/run/docker.sock`),
so the actual `fly launch`/`fly deploy` and a real image build are 🟡 **needs human** — see `docs/09-deploy.md`
§A, accurate against the current `infra/Dockerfile` / root `fly.toml` (moved there since this evidence was
first drafted, so every `fly` command needs no `--config`/`--dockerfile` flags) / env vars (`PORT`,
`CORS_ORIGIN`, `ROOM_FIXED_CODE`, `VIBE_MODEL`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_WEB_URL`).

What was verified instead, matching every step the Dockerfile and the workflow run:

1. **`infra/Dockerfile` reviewed**: `FROM oven/bun:1`, `WORKDIR /app`, `COPY . .`, `bun install`, `bun run
   fixtures`, `EXPOSE 8080`, `CMD ["bun", "apps/server/src/index.ts"]` — every step is exactly what's proven
   below to work from a clean checkout.
2. **`.dockerignore` reviewed**: excludes `node_modules`, `.git`, `.turbo`, `evidence`, the web build output
   and the gitignored `.wav` fixtures — nothing the server needs to boot or serve is excluded.
3. **Clean-checkout boot, simulating the Docker build exactly** (`git clone` the `agent/server` branch into a
   fresh directory with none of this session's `node_modules`/`fixtures/tracks/*.wav`, then run the
   Dockerfile's steps by hand):

   ```
   $ git clone --branch agent/server <repo> /tmp/hive-clean-checkout-test
   $ cd /tmp/hive-clean-checkout-test
   $ bun install            # 67 packages installed, hoisted linker from bunfig.toml
   $ bun run fixtures       # writes fixtures/tracks/synthetic-60s/*.wav + meta.json
   $ PORT=19321 bun apps/server/src/index.ts
   [hive-server] listening on http://localhost:19321 (protocol v1, cors *)

   $ curl -i http://localhost:19321/health
   HTTP/1.1 200 OK
   ...
   {"ok":true,"protocolVersion":1,"serverTime":1789860242971.8784}

   $ curl http://localhost:19321/tracks
   {"tracks":[{"id":"synthetic-60s", ... "urls":{"drums":"http://localhost:19321/audio/synthetic-60s/drums.wav", ...}}]}
   ```

   `FIXTURES_DIR` resolution (`apps/server/src/index.ts`: `import.meta.dir + "/../../../fixtures"`) is
   identical whether the repo root is `/app` (Docker's `WORKDIR`) or the clone's temp directory, since both
   put `apps/server/src/index.ts` at the same depth below the repo root — confirmed by `/tracks` returning
   working absolute URLs built from the request origin.

4. **`.github/workflows/deploy-fly.yml` reviewed**: triggers on push to `main` touching
   `apps/server/**`, `packages/protocol/**`, `fixtures/**`, `infra/**`, root `fly.toml`, `package.json`,
   `bun.lock`, or itself; `flyctl deploy --remote-only` (no flags needed now that `fly.toml` is at the repo
   root, with `dockerfile = "infra/Dockerfile"` inside it) with `FLY_API_TOKEN` from secrets; gated on
   `vars.FLY_DEPLOY_DISABLED != 'true'`. Valid YAML, matches `docs/09-deploy.md`'s manual `fly deploy`
   invocation exactly, so the human's one-time `fly launch` (step A2–A3) is all that's needed before every
   merge to `main` auto-deploys.
5. **`docs/09-deploy.md` re-read against the current code**: accurate as written — no changes needed.

## What the human must do

1. `fly auth login`, `fly launch --copy-config --no-deploy` from the repo root on `main` (`fly.toml` is
   already there; docs/09-deploy.md §A2). Accept region `ewr` (Fly retired `bos` for new machines).
2. `fly secrets set ROOM_FIXED_CODE=BZQ7 VIBE_MODEL=claude-sonnet-5 NEXT_PUBLIC_WEB_URL=https://<vercel-domain>`
   (+ `ANTHROPIC_API_KEY` if a Console key with credit is available — see B6 evidence).
3. `fly deploy --dockerfile infra/Dockerfile`, then `curl https://<app>.fly.dev/health` → `{"ok":true,...}`.
4. `fly tokens create deploy -x 999999h` → GitHub secret `FLY_API_TOKEN` so `deploy-fly.yml` deploys every
   merge to `main` automatically.
5. A real phone: join `https://<vercel-domain>/j/BZQ7` and confirm it reaches "Synced ±N ms" against the
   deployed server over WSS (docs/09-deploy.md §C).
