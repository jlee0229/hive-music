#!/bin/sh
# Builds the server image and proves it behaves the way production needs. Needs Docker and curl.
#   sh infra/smoke-test.sh              (from anywhere; CI runs exactly this)
# Run it by hand before any deploy that touched infra/, .dockerignore, bun.lock or a package.json.
#
# What it proves:
#   1. the image builds from the pruned context with a frozen lockfile;
#   2. the web app, docs, tests and tracks are NOT in the image;
#   3. a fresh, empty tracks directory is seeded with the synthetic pair at boot;
#   4. on a root-owned volume that already holds a track (= production), nothing is re-seeded,
#      the server runs as the unprivileged `bun` user and an upload still lands on the volume;
#   5. the server exits promptly on SIGINT, the signal Fly sends on deploy/restart.
set -eu

IMAGE=${IMAGE:-hive-server:smoke}
PORT=${SMOKE_PORT:-18080}
NAME="hive-smoke-$$"
VOL="hive-smoke-vol-$$"
cd "$(dirname "$0")/.."

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
die() { echo "SMOKE FAILED: $*" >&2; docker logs "$NAME" 2>&1 | tail -40 >&2 || true; exit 1; }

wait_healthy() {
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  die "server did not answer /health within 30 s"
}

# Prints the numeric uid of the server process inside the running container.
server_uid() {
  docker exec "$NAME" /bin/sh -c '
    for d in /proc/[0-9]*; do
      if tr "\000" " " < "$d/cmdline" 2>/dev/null | grep -q "^bun apps/server/src/index.ts"; then
        awk "/^Uid:/ { print \$2 }" "$d/status"
      fi
    done' | head -n 1
}

step "1/5 build"
docker build -f infra/Dockerfile -t "$IMAGE" .

step "2/5 image contents"
docker run --rm --entrypoint /bin/sh "$IMAGE" -c '
  set -e
  test -f /app/apps/server/src/index.ts
  test -f /app/packages/protocol/src/index.ts
  test -f /app/fixtures/gen-synthetic.ts
  test -d /app/node_modules/zod
  test ! -e /app/apps/web/app
  test ! -e /app/packages/sync-client/src
  test ! -e /app/docs
  test ! -e /app/evidence
  test ! -e /app/apps/server/src/__tests__
  test ! -e /app/node_modules/next
  test ! -e /app/node_modules/@playwright
  test -z "$(ls -A /app/fixtures/tracks)"
' || die "image contents are not what the Dockerfile promises"
docker image inspect "$IMAGE" --format 'image size: {{.Size}} bytes'

step "3/5 empty tracks directory is seeded at boot"
docker run -d --init --name "$NAME" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
wait_healthy
tracks=$(curl -fsS "http://127.0.0.1:$PORT/tracks")
echo "$tracks" | grep -q '"id":"synthetic-60s"' || die "synthetic-60s was not seeded"
echo "$tracks" | grep -q '"id":"synthetic-30s-lite"' || die "synthetic-30s-lite was not seeded"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/audio/synthetic-60s/drums.wav")
[ "$code" = "200" ] || die "seeded audio is not served (HTTP $code)"
docker rm -f "$NAME" >/dev/null

step "4/5 production shape: root-owned volume that already holds one track"
docker volume create "$VOL" >/dev/null
docker run --rm --entrypoint /bin/sh -v "$VOL:/app/fixtures/tracks" "$IMAGE" -c '
  set -e
  cd /app && bun fixtures/gen-synthetic.ts >/dev/null
  rm -rf /app/fixtures/tracks/synthetic-30s-lite
  chown -R root:root /app/fixtures/tracks'
docker run -d --init --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$VOL:/app/fixtures/tracks" "$IMAGE" >/dev/null
wait_healthy
tracks=$(curl -fsS "http://127.0.0.1:$PORT/tracks")
echo "$tracks" | grep -q '"id":"synthetic-60s"' || die "the pre-existing track disappeared"
if echo "$tracks" | grep -q '"id":"synthetic-30s-lite"'; then die "a non-empty library was re-seeded"; fi
uid=$(server_uid)
[ -n "$uid" ] || die "could not find the server process in the container"
[ "$uid" != "0" ] || die "the server is running as root (uid 0); see the entrypoint log above"
echo "server uid: $uid"
docker exec -i "$NAME" bun run - < infra/smoke-upload.ts || die "upload failed on a root-owned volume"
owner=$(docker exec "$NAME" /bin/sh -c 'stat -c %U /app/fixtures/tracks/smoke-test-*/mix.wav')
[ "$owner" = "bun" ] || die "the uploaded file is owned by '$owner', expected 'bun'"

step "5/5 exits on SIGINT (Fly's kill_signal) well inside kill_timeout"
docker kill --signal INT "$NAME" >/dev/null
i=0
while [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; do
  i=$((i + 1))
  [ "$i" -le 5 ] || die "still running 5 s after SIGINT"
  sleep 1
done
echo "stopped after ~$i s"

printf '\nSMOKE OK\n'
