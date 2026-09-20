# F1 — manual phone checklist (needs human)

No physical phones are available in this cloud environment. The Playwright half of F1 is automated and
passing (`apps/web/e2e/f1-player-join-ready.spec.ts`, screenshot `F1-ready.png`). This file is the 30-second
checklist a human should run on real hardware before marking F1 fully ✅.

## Setup

1. `bun run mock --scenario apps/web/mocks/scenarios/join.json` (or `party-12.json` for a fuller room).
2. `bun run --cwd apps/web dev` and note the LAN URL Next prints (or deploy a Vercel preview — see F9).
3. On each phone, open `http://<lan-ip>:3000/j/BZQ7` (or the Vercel preview `/j/BZQ7`).

## iOS Safari

- [ ] The ringer banner ("Ringer on, please") is visible on the Join screen.
- [ ] Type a name; it survives a reload (typed once, reload the tab, name is still there).
- [ ] Tap "Tap to join" — screen reaches "Synced" within a few seconds; the checkmark ring is green.
- [ ] "Downloading the song" reaches N / N parts.
- [ ] The "YOU'LL PLAY" card shows a role and its color.
- [ ] Open `/diag` in a second tab: `audio.state === 'ready'`, `connection === 'open'`, `rttMs`/`clockOffsetMs`
      are populated, `browserFamily === 'ios-safari'`.
- [ ] Lock the phone for 5s, unlock: the reconnect banner appears then clears; Ready state is intact.

## Android Chrome

- [ ] No ringer banner (Android does not need it).
- [ ] Same Join → Ready flow reaches "Synced" and `audio.state === 'ready'` on `/diag`.
- [ ] `browserFamily === 'android-chrome'` on `/diag`.

## Notes for whoever runs this

- The stub client (`NEXT_PUBLIC_HIVE_ENGINE=stub`, the default) fakes the 4-part download and never plays
  real audio — this checklist is validating the join/sync/UI flow against the mock server, not real audio
  output. Re-run this same checklist at F8 with `NEXT_PUBLIC_HIVE_ENGINE=real` against the backend agent's
  server once B2/B3 land, to also confirm audio.
