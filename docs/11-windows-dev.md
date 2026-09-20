# 11 · Windows dev notes

Setting the repo up on a Windows machine hit two things worth knowing:

## Line endings

Git for Windows defaults to `core.autocrlf=true`, which checks text files out with CRLF. The
sync-client test `rig-latency-page.test.ts` reads `rig/latency.html` as bytes and asserts on a
literal `\n`, so it fails on a CRLF checkout. `.gitattributes` now forces `eol=lf` for the whole
repo; if you cloned before that landed, run once:

```bash
git config core.autocrlf false
git rm --cached -r . -q
git reset --hard
```

## Port collisions

Anything can sit on 8080 (on Frank's machine it's llama-server). The server reads `PORT`, so put
the alternative in `apps/server/.env` (e.g. `PORT=8787`) and point `apps/web/.env.local`'s
`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` at the same port. Remember `NEXT_PUBLIC_*` is baked
into the bundle when `next dev` starts — restart the web dev server after changing it.

## Phone tests without deploying

`scripts/phone-test.ps1` automates docs/09 §E for Windows: starts two cloudflared quick tunnels,
rewrites both env files with the fresh tunnel URLs (they change every run), then starts the server
and web dev servers. It prints the host page URL (`…/h/BZQ7`) at the end. Requires `bun` and
`cloudflared` (`winget install Oven-sh.Bun Cloudflare.cloudflared`).

Two same-browser gotchas when smoke-testing without phones: all tabs of one browser share
`localStorage`, so a host tab and a join tab collide on `hive:clientId:<room>` (the join steals the
host's slot — on separate devices this can't happen); and background tabs throttle timers, so keep
the tab you're testing in the foreground.
