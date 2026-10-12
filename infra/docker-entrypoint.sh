#!/bin/sh
# Container entrypoint for the room server (infra/Dockerfile). Plain POSIX sh; keep it that way.
#
# Two jobs before the server starts, both fail-open: if either cannot be done the server still
# boots exactly the way the old image did (as root, with whatever tracks exist).
#
#   1. Seed. In production /app/fixtures/tracks is the `hive_tracks` volume, so nothing baked
#      into the image is visible there. An EMPTY tracks directory (fresh volume, or a plain
#      `docker run`) gets the two synthetic tracks generated into it. A directory that already
#      holds any track is left alone, so deleting the synthetic pair from a real library sticks.
#   2. Drop root. The volume is root-owned (Fly mounts it that way, and every track uploaded
#      before this image existed was written by root). Hand the tracks directory to the
#      unprivileged `bun` user, then exec the server as that user.
#
# Escape hatches: HIVE_RUN_AS_ROOT=1 skips step 2 (`fly secrets set HIVE_RUN_AS_ROOT=1`).
# A custom FIXTURES_DIR skips both steps: this script only knows the default location.

TRACKS_DIR=/app/fixtures/tracks
RUN_USER=bun

log() { echo "[hive-entrypoint] $*"; }

if [ -n "${FIXTURES_DIR:-}" ]; then
  log "FIXTURES_DIR is set ($FIXTURES_DIR): not seeding, not changing user"
  exec "$@"
fi

# --- 1. seed an empty library -------------------------------------------------------------
mkdir -p "$TRACKS_DIR" 2>/dev/null
if ! ls "$TRACKS_DIR"/*/meta.json >/dev/null 2>&1; then
  log "no tracks in $TRACKS_DIR: generating the synthetic pair"
  if ! bun /app/fixtures/gen-synthetic.ts >/dev/null; then
    log "WARNING: seeding failed; the library will be empty until a host uploads a song"
  fi
fi

# --- 2. drop privileges -------------------------------------------------------------------
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi
if [ "${HIVE_RUN_AS_ROOT:-0}" = "1" ]; then
  log "HIVE_RUN_AS_ROOT=1: staying root"
  exec "$@"
fi
if ! command -v setpriv >/dev/null 2>&1 || ! id "$RUN_USER" >/dev/null 2>&1; then
  log "WARNING: setpriv or user '$RUN_USER' is missing in this image: staying root"
  exec "$@"
fi
if ! setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups true 2>/dev/null; then
  log "WARNING: setpriv cannot switch to '$RUN_USER' here: staying root"
  exec "$@"
fi
if ! chown -R "$RUN_USER:$RUN_USER" "$TRACKS_DIR"; then
  log "WARNING: could not chown $TRACKS_DIR (uploads would fail unprivileged): staying root"
  exec "$@"
fi
HOME=/tmp
export HOME
exec setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups "$@"
