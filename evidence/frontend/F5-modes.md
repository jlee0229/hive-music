# F5 — mode chips + WAVE/STROBE animation

Playwright checks (automated, passing): `apps/web/e2e/f5-modes.spec.ts`

- Clicking each of the five chips (Unison, Orchestra, Stereo, Wave, Strobe) sends `SET_MODE` with the
  matching `mode` field, in order.
- After switching to Strobe, the Hive Map's dot fill-opacity changes over several animation frames
  (sampled every 120 ms) rather than staying pinned — confirming `evaluatePattern(assignment.pattern,
  trackTimeMs)` is being read from `client.clock.trackTimeSec()` on a `requestAnimationFrame` loop, not
  from a one-shot value.

## Visual recording

`F5-modes.webm` (gitignored; regenerate locally — see below) shows, in order: switching to Wave, then
Strobe, then back to Unison on the `party-12.json` scenario. A representative frame while Strobe is
active:

- The transport card reads "Strobe · 0:0x / 1:00" and the "Strobe" chip is highlighted (filled, dark text).
- On the Hive Map, dot fill brightness visibly differs across the group at the same instant — some dots
  near full brightness, others dimmed — which is the STROBE gate (`evaluatePattern`'s duty-cycle groups)
  animating client-side with zero extra server messages.
- The Player · Playing screen (component `PlayerPlayingScreen`) applies the same `patternGain` as a
  full-screen dark overlay (`opacity = (1 - gain) * 0.85`), so a player assigned a STROBE pattern sees
  their screen flash to black on the gate's off-phase; WAVE instead swells smoothly (raised-cosine).

## Regenerating the video

```
bun run mock --scenario apps/web/mocks/scenarios/party-12.json
bun run --cwd apps/web dev
cd apps/web
bunx playwright test --headed -g "record" # or re-add a small recording spec with test.use({video:'on'})
```

The mp4 muxer isn't available in the preinstalled ffmpeg build in this environment (only webm), so the
raw Playwright recording is kept as `.webm` — still plays in any modern browser/player.
