# 11 · Windows dev notes

The project is developed and deployed from a Windows 11 machine. The [README](../README.md) steps work as written;
this page is the list of things that are different or surprising on Windows. (Last walked through 2026-10-11:
fresh clone → install → fixtures → typecheck → unit tests → both dev servers → host a hive → a second browser joins.)

## Install

```
winget install Oven-sh.Bun OpenJS.NodeJS.LTS Git.Git
```

Open a **new** terminal afterwards: winget does not refresh `PATH` in the one you ran it from, and `bun` will be
"not recognized" until you do. Tools that spawn `bun` themselves (the e2e mock helper) accept an absolute path in
the `BUN_BIN` environment variable for the same reason.

## Line endings

Git for Windows defaults to `core.autocrlf=true`, which checks text files out with CRLF. One sync-client test
(`rig-latency-page.test.ts`) reads `rig/latency.html` as bytes and asserts on a literal `\n`. `.gitattributes`
forces `eol=lf` for the whole repo, so a fresh clone is fine. Only if you cloned before that file existed:

```bash
git config core.autocrlf false
git rm --cached -r . -q
git reset --hard
```

## Ports

Anything can sit on 8080 (on the founder's machine it is a local LLM server — do not kill it). The server reads
`PORT`: put `PORT=8787` in `apps/server/.env`, and point `apps/web/.env.local` at it
(`NEXT_PUBLIC_API_URL=http://localhost:8787`, `NEXT_PUBLIC_WS_URL=ws://localhost:8787/ws`). `NEXT_PUBLIC_*` is
baked in when `next dev` starts, so restart the web dev server after changing it. The e2e suite has its own knobs:
`$env:HIVE_MOCK_PORT = "8180"` before `bun run e2e` when 8080 is busy.

To see what owns a port: `Get-NetTCPConnection -LocalPort 8080 -State Listen | Select OwningProcess`, then
`Get-Process -Id <pid>`.

## Playwright

Run it through node — `bun run e2e` does (`node ../../node_modules/@playwright/test/cli.js test` from `apps/web`).
`bun x playwright` fails on Windows with `spawn UNKNOWN` when it tries to launch the browser. First run:
`cd apps\web; node ..\..\node_modules\@playwright\test\cli.js install chromium`.

Never run `next build` in `apps/web` while `next dev` or the e2e suite is running there; both write `.next`.

## git from PowerShell

Windows PowerShell 5.1 mangles nested quotes in `git commit -m "…"`. Write the message to a file and use
`git commit -F message.txt`, or run git from Git Bash.

## Real phones without deploying

`scripts\phone-test.ps1` starts two cloudflared quick tunnels, rewrites both env files with the fresh tunnel
URLs (they change every run), then starts the server and web dev servers and prints the URL to open on the host
phone. Needs `cloudflared` (`winget install Cloudflare.cloudflared`). It overwrites `apps\web\.env.local` and
`apps\server\.env`; a file it did not write itself is first copied to `<name>.before-phone-test`. The tunnel URLs
are public while the script's windows are open.

This is the way to try unreleased code on real phones. Production is not a test bed: deploying the server
there ends every party in progress ([13-operations.md](13-operations.md) §2.3).

## Smoke-testing in one browser

All tabs of one browser share `localStorage`, and host and player both key their identity on
`hive:clientId:<room>` — a join tab steals the host's slot (on separate devices this cannot happen). Use a second
browser or a private window for the second "phone". Background tabs also throttle timers, so keep the tab you are
testing in the foreground.
