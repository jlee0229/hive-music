# 09 · Deploy runbook (human, ~20 minutes, once)

Owner: the human. After this, every merge to `main` deploys the server automatically and Vercel builds every push.

## A. Fly.io — the Bun server (`apps/server`)

Requires a Fly account with a payment method (the app runs on one tiny always-on machine).

```bash
# 1. install + login (macOS: brew install flyctl; otherwise: curl -L https://fly.io/install.sh | sh)
fly auth login

# 2. from the repo root, on main (git pull first)
fly launch --copy-config --no-deploy
#    (fly.toml is in the repo root; the Dockerfile path is inside it.) Accept region ewr; if the app name
#    "hivemusic-server" is taken, pick another (fly.toml is updated in place). Already launched? skip to step 3.

# 3. runtime config (leave CORS_ORIGIN unset for the hackathon: the server defaults to "*").
fly secrets set ROOM_FIXED_CODE=BZQ7 VIBE_MODEL=claude-sonnet-5 NEXT_PUBLIC_WEB_URL=https://<your-vercel-domain>
#    optional, only if you have a Console key with credit:
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# 4. first deploy + check
fly deploy --dockerfile infra/Dockerfile
curl https://<app>.fly.dev/health      # → {"ok":true,"protocolVersion":1,...}

# 5. let GitHub deploy on every merge to main
fly tokens create deploy -x 999999h    # copy the whole token, including the leading "FlyV1"
#    GitHub → repo → Settings → Secrets and variables → Actions → New secret: FLY_API_TOKEN
#    .github/workflows/deploy-fly.yml then deploys on every push to main that touches the server, protocol, fixtures or infra.
```

Two facts to remember: rooms live in memory, so **never scale to more than one machine**; and `auto_stop_machines = false`
in `fly.toml` is what keeps the room alive between songs — do not "optimize" it away.

## B. Vercel — the PWA (`apps/web`)

```
vercel.com → Add New… → Project → Import jlee0229/hive-music
  Framework preset:   Next.js
  Root Directory:     apps/web        (tick "Include source files outside of the Root Directory in the Build Step")
  Build command:      next build      (default)
  Install command:    bun install     (Bun is detected from packageManager in the root package.json)
  Production branch:  main
Environment variables (all environments):
  NEXT_PUBLIC_API_URL      = https://<app>.fly.dev
  NEXT_PUBLIC_WS_URL       = wss://<app>.fly.dev/ws
  NEXT_PUBLIC_HIVE_ENGINE  = stub        ← switch to "real" once the engine's INT PR is merged
Deploy.
```

Every push to `agent/frontend` gets a preview URL (phone-testable HTTPS); `main` is production. Put the production URL into the Fly
secret `NEXT_PUBLIC_WEB_URL` (step A3) so the QR code points at it, then `fly deploy` once more (or merge anything to `main`).

## C. Smoke test on phones (5 minutes)

1. Open `https://<vercel-domain>/h/BZQ7` on the host phone → Lobby with the QR.
2. Scan with two phones → `/j/BZQ7` → tap to join → both reach "Synced ±N ms".
3. `/diag` on each phone: connection `open`, rtt < 60 ms on Wi-Fi, clock offset stable.
4. If anything fails: `fly logs` for the server, the Vercel deployment log for the web, and `https://<app>.fly.dev/health` first.

## D. Uploading real tracks (B9, stretch)

`POST /tracks` (host-only, needs the room's `hostKey`) takes real music instead of the synthetic track.
Prepare stems on a laptop first — Replicate is out of scope, so separation happens before the demo, not on Fly:

```bash
# 1. pick a <=60s clip of a file you own, e.g. clip.wav
# 2. separate it into 4 stems (or 2, with --two-stems=vocals)
pip install demucs   # or: pipx install demucs
demucs -n htdemucs clip.wav              # -> separated/htdemucs/clip/{drums,bass,vocals,other}.wav
# 3. convert every stem to the upload spec: mono, PCM (any depth/rate — the server converts the rest)
ffmpeg -i separated/htdemucs/clip/drums.wav -ac 1 -t 60 drums.wav   # repeat for bass/vocals/other
# 4. upload (any of the 4 field names below, 1-4 of them, or a single "mix" field instead)
curl -F title="My Track" -F hostKey="$HOST_KEY" \
     -F drums=@drums.wav -F bass=@bass.wav -F vocals=@vocals.wav -F other=@other.wav \
     https://<app>.fly.dev/tracks
```

The server re-encodes every stem to mono 16-bit PCM and resamples it to 44100 Hz with pure-TS code — no
`ffmpeg` on Fly, so the conversion step above only needs to get the file *readable* (mono/PCM), not exact.

**Uploads do not survive a redeploy.** Fly's default disk is ephemeral, and `bun run fixtures` on the
next `Dockerfile` build starts from an empty `fixtures/tracks/`, so an uploaded track vanishes the moment
`deploy-fly.yml` runs again (any merge touching `apps/server/**` etc. — see the workflow's `paths`). Upload
again after each deploy, or add a persistent volume before the demo: `fly volumes create hive_tracks --size 1`,
mount it at `/app/fixtures/tracks` in `fly.toml`'s `[[mounts]]`, and re-run `bun run fixtures` once after the
first mount so the synthetic track still exists there too.

## E. If Fly or Vercel are not available in time

Quick tunnels from any laptop on the same Wi-Fi give HTTPS in five minutes, no accounts:

```bash
bun run --cwd apps/server dev                          # :8080
bun run --cwd apps/web dev                             # :3000
cloudflared tunnel --url http://localhost:8080          # → https://<random>.trycloudflare.com  (server)
cloudflared tunnel --url http://localhost:3000          # → https://<random>.trycloudflare.com  (web)
# put the server URL into apps/web/.env.local as NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL (wss://…/ws) and restart the web dev server
```
