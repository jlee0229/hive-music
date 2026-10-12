# The HiveMusic room server (apps/server + packages/protocol). Build context = the repo root:
#   docker build -f infra/Dockerfile -t hive-server .
# Fly builds it the same way (fly.toml [build] dockerfile). `sh infra/smoke-test.sh` builds the
# image and proves it boots, seeds, drops root, serves and accepts an upload; CI runs that script
# on every push, and it is the check to run by hand before a deploy that touched this file.
#
# BUN_VERSION must match `packageManager` in the root package.json and the CI workflows:
# scripts/check-versions.ts fails CI when they drift apart.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim

ENV NODE_ENV=production
WORKDIR /app

# 1. Dependencies first, from manifests only, so this layer is rebuilt only when they change.
#    All four workspace manifests are present so the frozen lockfile resolves, but only the
#    server's production dependencies are installed (10 packages; no Next, no Playwright).
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/sync-client/package.json packages/sync-client/package.json
RUN bun install --frozen-lockfile --production --filter '@hive/server' \
    && rm -rf /root/.bun/install/cache

# 2. Source. Bun runs the TypeScript directly; there is no build step.
COPY tsconfig.base.json ./
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/protocol/src packages/protocol/src
COPY fixtures/gen-synthetic.ts fixtures/gen-synthetic.ts
COPY infra/docker-entrypoint.sh infra/docker-entrypoint.sh

# No tracks are generated at build time: in production /app/fixtures/tracks is a volume, which
# hides anything baked in here. The entrypoint seeds an empty tracks directory at boot instead.
RUN mkdir -p /app/fixtures/tracks

EXPOSE 8080

# Fly ignores Docker HEALTHCHECK (it uses [[http_service.checks]] in fly.toml); this is for
# `docker run`/compose and any other host. bun is the only HTTP client in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health'); process.exit(r.ok ? 0 : 1)"]

# The entrypoint starts as root (the volume is root-owned), seeds and chowns the tracks
# directory, then drops to the unprivileged `bun` user before exec'ing the server. Invoked
# through /bin/sh so it does not depend on the file's executable bit surviving a Windows checkout.
ENTRYPOINT ["/bin/sh", "/app/infra/docker-entrypoint.sh"]
CMD ["bun", "apps/server/src/index.ts"]
