# F3 — manual phone checklist (needs human)

No physical phones are available in this cloud environment. The Playwright half of F3 is automated and
passing (`apps/web/e2e/f3-player-playing.spec.ts`, screenshot `F3-playing.png`): ASSIGN from a host
connection recolors the Playing screen, and releasing the nudge slider sends exactly one `NUDGE`.

## Setup

1. `bun run mock --scenario apps/web/mocks/scenarios/party-12.json` (transport already playing).
2. `bun run --cwd apps/web dev`; open `http://<lan-ip>:3000/j/BZQ7` on the phone.

## Checklist

- [ ] Tap to join reaches the Playing screen directly (transport is already playing in this scenario) —
      full-screen role color, role label, track title + time.
- [ ] The sync pill in the top-right shows a small green dot and a `±N ms` reading that looks alive.
- [ ] Drag the "Sound early or late?" slider and release: the value near the slider updates immediately;
      nothing about the screen should feel like it's spamming — the input has clearly "settled".
- [ ] Tap "Mute my phone" — the button flips to "Unmute my phone" (local mute only; sound output should
      change once the real engine is wired in at F8).
- [ ] **Visibility test:** switch away from the browser tab/app for 5–10 s, then switch back. The track
      time shown should reflect real elapsed time (i.e. it should have "caught up", not resumed from
      where it paused) — this is what `client.clock.trackTimeSec()` derived from `room.transport` gives
      for free, since nothing is scheduled ahead of time; confirm on `/diag` too (`connection` should
      read `open`, not stuck `reconnecting`).
- [ ] Lock the phone briefly and unlock: the reconnect banner (if it appears) clears within a few
      seconds and the role/color/time are still correct afterwards.

## Notes for whoever runs this

Re-run this same checklist at F8 with `NEXT_PUBLIC_HIVE_ENGINE=real` to also confirm actual audio output
and wake-lock behavior, since the stub client never plays sound.
