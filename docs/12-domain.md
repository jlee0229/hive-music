# 12 · playhivemusic.com

The production layout for the domain (bought on Namecheap, DNS stays at Namecheap):

| host | points at | serves |
|---|---|---|
| `playhivemusic.com` | Vercel | the Next.js PWA (landing, `/h`, `/j`, `/screen`, `/diag`) |
| `www.playhivemusic.com` | Vercel | redirect to the apex |
| `api.playhivemusic.com` | Fly | the Bun server (REST + `/ws` + `/audio`) |

Deploy mechanics are docs/09; this file is the domain-specific delta.

## Human-only steps (accounts + DNS)

1. **Fly**: `fly auth signup` (or login) — needs a payment method; the app runs one tiny
   always-on machine (~$3–5/mo).
2. **Vercel**: `vercel login`, then import `jlee0229/hive-music` in the dashboard
   (Root Directory `apps/web`, tick "Include source files outside the Root Directory",
   install command `bun install`). The dashboard import is required once; after that the
   Git integration builds every push, `main` = production.
3. **Namecheap DNS** (Domain List → playhivemusic.com → Advanced DNS), after steps 4–5 below
   produce the exact targets:
   - `A @ 76.76.21.21` (Vercel apex — Vercel's domain screen confirms the current IP)
   - `CNAME www cname.vercel-dns.com`
   - `CNAME api hivemusic-server.fly.dev` (or whatever `fly certs add` prints)

## Scripted steps (run from the repo root once logged in)

4. Fly, first time:
   ```bash
   fly launch --copy-config --no-deploy      # accept ewr; rename app if taken (fly.toml updates)
   fly secrets set ROOM_FIXED_CODE=BZQ7 NEXT_PUBLIC_WEB_URL=https://playhivemusic.com
   fly volumes create hive_tracks --size 1 --region ewr   # uploads survive redeploys
   #   then add to fly.toml:  [[mounts]]  source = "hive_tracks"  destination = "/app/fixtures/tracks"
   fly deploy --dockerfile infra/Dockerfile
   fly ssh console -C "bun run /app/fixtures/gen-synthetic.ts"   # once, seeds the mounted volume
   fly certs add api.playhivemusic.com       # prints the DNS target for step 3
   curl https://api.playhivemusic.com/health
   ```
5. Vercel project env (all environments), then redeploy:
   ```
   NEXT_PUBLIC_API_URL = https://api.playhivemusic.com
   NEXT_PUBLIC_WS_URL  = wss://api.playhivemusic.com/ws
   ```
   Add `playhivemusic.com` + `www.playhivemusic.com` under Project → Settings → Domains.
6. CI auto-deploy for the server: `fly tokens create deploy -x 999999h` → GitHub repo secret
   `FLY_API_TOKEN` (docs/09 §A5). Vercel deploys via its Git integration on its own.

## After it's live

- Music: upload songs through the host lobby's **+ Upload a song** button — they land on the
  mounted volume and survive redeploys. (Local `fixtures/tracks/baby` is deliberately not in
  the image: .dockerignore.)
- Smoke test: `https://playhivemusic.com/h/BZQ7` → QR shows `playhivemusic.com/j/BZQ7`
  (that URL comes from the `NEXT_PUBLIC_WEB_URL` Fly secret), two phones join, auto-tune, play.
- CORS stays `*` (server default) for now; to lock it down set the Fly secret
  `CORS_ORIGIN=https://playhivemusic.com`.
