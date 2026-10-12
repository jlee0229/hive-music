# 13 · Operations runbook

How to deploy, check, roll back and repair production. Written 2026-10-11 from the code and
configs in this repo by someone who could **not** run `flyctl` or `vercel`.

> **Read this box once.** Lines marked ⚠ are standard Fly/Vercel commands that have not been
> rehearsed against this app. They are believed correct; the first person to run one should fix
> this page if it is not. Everything about the server's own behaviour (what a restart does, memory,
> the backfill, file layout) was measured or read from the code and is exact.

## 1. What runs where

| piece | where | details |
|---|---|---|
| Web app (`apps/web`, Next.js) | Vercel, project `playhivemusic` | `https://playhivemusic.com` (+ `www` → apex). Root directory `apps/web`, install command `bun install`. Deployed **by hand** with the Vercel CLI; pushing to GitHub does not deploy. |
| Room server (`apps/server`, Bun) | Fly.io, app `playhivemusic-api`, region `ewr` | `https://api.playhivemusic.com` (REST, `/ws`, `/audio`). **One machine.** Config: [`fly.toml`](../fly.toml), image: [`infra/Dockerfile`](../infra/Dockerfile). Deployed **by hand** with `flyctl`. |
| Uploaded songs | Fly volume `hive_tracks`, 1 GB | mounted at `/app/fixtures/tracks`; one folder per track (`<id>/mix.wav` + `meta.json`). Survives deploys. Daily Fly snapshots. |
| Rooms, players, playlists | the server process's memory | **Not persisted.** Gone on every restart. |
| DNS | Namecheap | records in [12-domain.md](12-domain.md) |
| Source | `github.com/piar1243/hive-music-official`, branch `main` | CI runs on every push ([`ci.yml`](../.github/workflows/ci.yml)); nothing auto-deploys. |

Configuration that is not in the repo:

- **Vercel project env** (baked into the bundle at build time): `NEXT_PUBLIC_API_URL=https://api.playhivemusic.com`,
  `NEXT_PUBLIC_WS_URL=wss://api.playhivemusic.com/ws`. `NEXT_PUBLIC_HIVE_ENGINE` must be unset (unset = real audio).
- **Fly secrets**: none are needed. `PORT` and `NEXT_PUBLIC_WEB_URL` are in `fly.toml`. `ROOM_FIXED_CODE` must
  **not** be set (hackathon switch; with it, everyone shares one room). `CORS_ORIGIN` is unset, so the server
  answers `Access-Control-Allow-Origin: *` (checked 2026-10-11). `ANTHROPIC_API_KEY` is unset, so the vibe
  director uses its built-in rules. ⚠ Confirm with `fly secrets list -a playhivemusic-api`; if an old
  `NEXT_PUBLIC_WEB_URL` or `ROOM_FIXED_CODE` secret is still there, remove it (`fly secrets unset NAME` —
  this restarts the machine, see §2.3).

## 2. Deploy

### 2.1 Before any deploy

```
git status                 # clean, on the commit you mean to ship
bun run check              # versions + typecheck + lint + unit tests + e2e   (README "Testing")
```

Touched `infra/`, `.dockerignore`, `bun.lock` or any `package.json`? Also run `sh infra/smoke-test.sh`
(needs Docker), or wait for the green **server image** job in CI on that commit.

### 2.2 Web only

```
vercel deploy --prod --yes          # ⚠ from the repo root
```

The repo root is linked to the Vercel project through `.vercel/project.json` (gitignored). On a new machine:
`vercel login`, then `vercel link` and pick `playhivemusic` ⚠.

A web deploy does not interrupt a running party: phones keep running the bundle they already loaded and their
WebSockets go to Fly, not Vercel. A phone that reloads gets the new bundle.

### 2.3 Server — read this first: what a deploy does to a party

A server deploy stops the one machine and starts it again on the new image (the `rolling` strategy — the only one
possible with a volume attached). Fly sends SIGINT; the server has no shutdown handler and simply exits.

- Every WebSocket drops. Phones show their reconnecting state and retry.
- When the server is back (typically well under a minute), **every room is gone**. Codes are random, so the
  old code cannot be re-created: `POST /rooms {"code":"<old>"}` answers 400 and players get "Hive not found".
  (Reproduced locally 2026-10-11.) The host must tap **Host a hive** again and everyone must re-scan.
- Uploaded songs are untouched (volume).

So: **deploy when nobody is playing.** There is currently no exact way to know — `/health` does not report
room counts and the server logs nothing about rooms (both are open proposals, see §10). What you can do:

1. Pick a quiet hour (weekday morning US Eastern, not Friday/Saturday night).
2. ⚠ Look at the Fly dashboard → app `playhivemusic-api` → Metrics → concurrency/connections. Every connected
   phone holds one WebSocket; a flat line near zero means nobody is in a hive.
3. If you know a code that is in use, `curl https://api.playhivemusic.com/rooms/<CODE>` → `{"exists":true,"players":N}`.

Then:

```
flyctl deploy --remote-only         # ⚠ from the repo root; app + Dockerfile come from fly.toml
```

(`flyctl deploy --dockerfile infra/Dockerfile --app playhivemusic-api --remote-only` is the same thing spelled out.)

No flyctl on your machine? GitHub → Actions → **Deploy server to Fly** → Run workflow → type `deploy`.
It needs the repository secret `FLY_API_TOKEN` (`fly tokens create deploy -a playhivemusic-api` ⚠), which is
not set as of 2026-10-11 — without it the workflow stops in its first step and says so.

**First deploy after 2026-10-11 changes three things at once** — watch `fly logs` during it:
the image is new (pinned Bun, non-root, self-seeding entrypoint: expect `[hive-entrypoint]` lines only if
something had to be done or could not be), `fly.toml` now sets the machine to 1 GB + 512 MB swap (a cost change;
see §7), and the restart policy is `always`. If the server does not come up, §4.

### 2.4 Both (any change to `packages/protocol`, especially `PROTOCOL_VERSION`)

The web bundle compares its own `PROTOCOL_VERSION` with the server's `/health` before connecting; on a mismatch it
reloads once and then shows an "older version" banner. So a protocol bump needs **both halves deployed back to
back**: server first (it is the one that ends parties anyway), web immediately after. Then verify (§3) that
`/health` reports the number in `packages/protocol/src/constants.ts`.

## 3. Verify

```
curl https://api.playhivemusic.com/health
# {"ok":true,"protocolVersion":4,"serverTime":...}     protocolVersion must equal PROTOCOL_VERSION in packages/protocol/src/constants.ts
curl -s https://api.playhivemusic.com/tracks | head -c 300
# {"tracks":[{"id":...        the library is there (an empty volume would show only the two synthetic tracks)
```

Then the real test, on two phones (not two tabs of one browser — they share localStorage and steal each other's
identity): open `https://playhivemusic.com`, **Host a hive** on one, scan the QR with the other, pick a song,
Start. Both play, in time. `https://playhivemusic.com/diag` on a phone shows connection, round-trip time and clock
offset if something looks off.

⚠ `fly status -a playhivemusic-api` should show one machine, `started`, checks passing.

## 4. Roll back

**Web** ⚠ — Vercel keeps every deployment:

```
vercel ls                           # recent deployments, newest first
vercel rollback                     # back to the previous production deployment
vercel promote <deployment-url>     # or pick a specific one
```

(or dashboard → Deployments → the last good one → "Promote to Production" / "Instant Rollback").

**Server** ⚠ — Fly keeps the image of every release:

```
fly releases -a playhivemusic-api --image        # version, status, date, image reference
fly deploy -a playhivemusic-api --image <image reference of the last good release>
```

A rollback is another restart: it ends parties again. `fly.toml` in your working tree still applies to an
`--image` deploy, so check out the commit that matches the image if the config changed too.

If the new image boots but uploads fail with permission errors (the non-root change), the one-line escape is
`fly secrets set HIVE_RUN_AS_ROOT=1 -a playhivemusic-api` ⚠ (restarts the machine; the entrypoint then stays root).

## 5. Logs and status

```
fly logs -a playhivemusic-api                # ⚠ live tail
fly status -a playhivemusic-api              # ⚠ machine state + health checks
fly scale show -a playhivemusic-api          # ⚠ machine size and memory
fly machine list -a playhivemusic-api        # ⚠
```

What the server itself logs is very little: one `listening on … (protocol vN, cors …)` line at boot, and the
tempo backfill result (§7). It does not log rooms, joins, uploads or errors. An out-of-memory kill shows up in
Fly's own log lines (look for `Out of memory` / `oom`), followed by a fresh `listening on` line.

Web: Vercel dashboard → the deployment → Logs (build and runtime). The app is almost entirely client-side;
runtime logs are rarely interesting.

## 6. The volume (uploaded songs)

Layout: `/app/fixtures/tracks/<id>/mix.wav` (mono, 16-bit, 44.1 kHz) + `meta.json` (title, duration, energy
curve, tempo). `<id>` is the slugged title plus 8 hex characters. Size: **5.3 MB per minute of audio**
(measured: 52.9 MB for a 10-minute upload, the maximum). 1 GB therefore holds roughly 19 maximum-length songs,
or about 54 typical three-and-a-half-minute ones. The library is global (every hive sees every upload), there is
no delete in the product and no quota — the volume **will** fill. When it does, uploads fail; playback of
existing songs keeps working.

All of these are ⚠:

```
# how full is it
fly ssh console -a playhivemusic-api -C "df -h /app/fixtures/tracks"

# what is on it, biggest first
fly ssh console -a playhivemusic-api -C "sh -c 'du -sm /app/fixtures/tracks/* | sort -rn | head -30'"

# titles
fly ssh console -a playhivemusic-api -C "sh -c 'grep -H title /app/fixtures/tracks/*/meta.json'"

# back up everything to your machine
fly ssh console -a playhivemusic-api -C "tar -czf /tmp/tracks.tgz -C /app/fixtures tracks"
fly ssh sftp get /tmp/tracks.tgz ./tracks-backup.tgz -a playhivemusic-api
fly ssh console -a playhivemusic-api -C "rm /tmp/tracks.tgz"

# back up or restore one track (sftp shell: get / put, one file at a time)
fly ssh sftp shell -a playhivemusic-api

# delete one track
fly ssh console -a playhivemusic-api -C "rm -r /app/fixtures/tracks/<id>"
```

After deleting or restoring files by hand:

- The server keeps its track list in memory and re-reads the folder only at boot and after each upload. A deleted
  track stays in the picker (and 404s when played) until then; a restored one does not appear until then. Either
  wait for the next upload or restart (`fly apps restart playhivemusic-api` ⚠ — ends parties, §2.3).
- `fly ssh` works as root, the server runs as user `bun`. Files you **put** there are root-owned; the next boot
  fixes ownership, or run `chown -R bun:bun /app/fixtures/tracks` in the console.
- Never put a `/` or `..` in an id; the server only serves ids matching `[A-Za-z0-9_-]+`.

**Snapshots.** Fly snapshots the volume daily; `fly.toml` keeps 14 days (`snapshot_retention`).
`fly volumes list -a playhivemusic-api` ⚠ then `fly volumes snapshots list <volume id>` ⚠. Restoring a whole
snapshot means creating a new volume from it and moving the machine onto it — this has never been done for
this app; follow Fly's "restore a volume from a snapshot" guide and expect downtime. For a single lost song the
tar/sftp backup above is the practical route, so take one before anything risky.

**An empty volume** (new volume, or after a wipe) is handled by the image: on boot the entrypoint generates the
two synthetic tracks if the folder holds no track at all. The old manual step
(`fly ssh console -C "bun run /app/fixtures/gen-synthetic.ts"`) is no longer needed.

## 7. Memory, and the tempo backfill

**Memory** (measured locally 2026-10-11, Bun 1.4.2): idle ≈ 53 MB; one 10-minute upload peaks at ≈ 363 MB;
four back to back ≈ 748 MB. `fly.toml` therefore asks for a 1 GB machine with 512 MB swap. Before 2026-10-11 the
size was not in `fly.toml` at all; if `fly scale show` reports 256 MB on a machine deployed before that, long
uploads have been able to kill the server. Do not size the machine below 512 MB.

**Tempo backfill.** Every uploaded track's `meta.json` carries `bpm`, `beatOffsetSec` and `bpmVersion`. At every
boot the server walks the library and re-analyses any uploaded track whose `bpmVersion` differs from
`BPM_ALGORITHM_VERSION` in `apps/server/src/upload/bpm.ts` (3 as of this writing), rewrites its `meta.json`, and
logs `bpm backfill: (re)analyzed tempo for N track(s) at vX`. To re-run tempo detection on the whole production
library after improving the detector: bump that constant and deploy the server. It runs once per track per
version (about 0.2 s per 10-minute track on a desktop, expect a few seconds each on Fly's shared CPU; it loads
each track fully into memory, one at a time). A track on which
detection finds nothing gets no `bpm` and is retried at each boot. To inspect one:
`fly ssh console -C "cat /app/fixtures/tracks/<id>/meta.json"` ⚠.

## 8. Secrets and rotation

There is nothing to rotate: production uses no API keys or passwords (§1). The things that are credentials are
personal logins — the Fly account, the Vercel account, Namecheap, GitHub — and, if someone creates it, the
`FLY_API_TOKEN` GitHub secret (revoke with `fly tokens list` / `fly tokens revoke` ⚠). If an
`ANTHROPIC_API_KEY` is ever set (`fly secrets set`), it becomes the first real secret: note here who owns it.

The **host key** of a room is a per-room random UUID kept in the host phone's localStorage; it is not an
operational secret, and it dies with the room.

## 9. Incident checklists

### "The site is down"

1. Which half? `https://playhivemusic.com` not loading → Vercel. Page loads but "Could not start the hive" /
   endless connecting → server.
2. `curl https://api.playhivemusic.com/health`. No answer → `fly status` ⚠, `fly logs` ⚠. Machine `stopped` →
   `fly machine start <id>` ⚠. Crash-looping right after a deploy → roll back (§4).
3. Vercel: dashboard → Deployments. Latest failed or wrong → promote the last good one (§4).
4. DNS/certificates last: records in [12-domain.md](12-domain.md); `fly certs show api.playhivemusic.com` ⚠.

### "Nobody can join"

1. Did the server restart? A restart kills every room (§2.3). `fly logs` shows a fresh `listening on` line.
   The fix is for the host to start a new hive from the landing page. There is no way to revive the old code.
2. "Hive not found" on one phone only → wrong code, or the room emptied out and expired (an empty room is
   removed after 10 minutes).
3. Banner about an "older version" → web and server disagree on `PROTOCOL_VERSION` (§2.4): deploy the half that
   is behind.
4. Stuck connecting on venue Wi-Fi → captive portal or blocked WebSockets; try mobile data or a phone hotspot.
   `/diag` on the phone shows the connection state.

### "Phones are silent" (joined, shows playing, no sound)

1. One phone: iPhone ring/silent switch on silent, or media volume at zero; another app holding audio. Then reload the
   join page on that phone (it keeps its identity and rejoins).
2. Every phone, one song: `curl -I https://api.playhivemusic.com/audio/<id>/mix.wav` — a 404 means the track's
   file is gone from the volume while it is still listed (§6).
3. Every phone, every song: is the host actually playing (Start pressed, not paused)? Then `/health`, then `fly logs`.
4. Sound, but out of time: that is a sync problem, not an outage — `/diag` on the offending phone (round-trip time,
   clock offset) and move it to better Wi-Fi. The acoustic tuning moment runs automatically when the host presses Start.

### "Uploads fail"

1. Volume full → §6 (`df -h`), delete something.
2. Permission errors in `fly logs` right after the non-root image shipped → §4 (`HIVE_RUN_AS_ROOT=1`).
3. Server restarts during the upload → memory (§7): `fly scale show`.

## 10. Things that look safe and are not

- `fly scale count 2` — splits parties across two servers that cannot see each other. One machine, always.
- Turning on `auto_stop_machines` — the machine would stop between songs and take the room with it.
- `fly secrets set/unset`, `fly apps restart`, `fly scale memory …` — each restarts the machine: every party ends.
- Setting `ROOM_FIXED_CODE` in production — everyone who taps "Host a hive" lands in the same room.
- Merging to `main` is safe (nothing deploys). Re-adding a `push` trigger to the deploy workflow is not.
- Running `next build` in `apps/web` while `next dev` (or the e2e suite) is running there — it corrupts the dev cache.
- `git add -A` after running the e2e suite — it rewrites the screenshots in `evidence/frontend/`
  (`git checkout -- evidence/frontend` first).

Open proposals that would shrink this page (see `findings/infra-docs.md` in the 2026-10 audit: INFRA-04, -05, -16):
room and connection counts in `/health`; a shutdown notice to phones; rooms that survive a restart; server-side
logging of rooms, uploads and errors; an upload size check before decoding; a delete/quota for the library.
