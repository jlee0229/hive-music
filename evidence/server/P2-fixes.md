# P2 fixes (lower priority than the P0 demo-risk pass)

```
$ bun run --cwd apps/server test src/__tests__/p0-fixes.test.ts
bun test v1.3.11 (af24e281)

 6 pass
 0 fail
 26 expect() calls
Ran 6 tests across 1 file. [38.00ms]
```

## P2-10 — strip `device.userAgent` from broadcast `ClientRecord`s

`DeviceInfoSchema.userAgent` is a required `z.string().max(512)` (not optional — no schema change was
possible without a protocol request, and none is needed), and nothing server-side reads the string itself,
only `browserFamily`/`platform`/`model`. At 30 phones it was most of a `ROOM_STATE` snapshot's size.
`join()` now stores `{ ...msg.device, userAgent: "" }` for every client record instead of the real
string — an empty string still satisfies the schema, and every other device field (`browserFamily`, which
`STARTER_LATENCY_TABLE_MS` keys off, `platform`, `model`) survives unchanged.

Test: a `JOIN` carrying a long real user-agent string ends up with `device.userAgent === ""` in the room's
client record, while `browserFamily` and the table lookup both still work.

## P2-11 — a `SET_MODE` tapped while a vibe request is in flight is no longer clobbered

`POST /rooms/:code/vibe` can take up to 5s (the LLM call's own timeout). If the host tapped a mode chip
during that window, `acceptScenePlan()` would land afterward and silently override their manual choice —
the vibe response arriving "in the past" relative to what they'd already decided. Fixed with a version
counter: `Room.modeVersion` increments on every manual `SET_MODE`; the vibe route in `index.ts` snapshots
`room.getModeVersion()` *before* calling `directScene()`, and `acceptScenePlan(plan, requestModeVersion)`
drops the plan (returns `false`, room state untouched) if the version has moved since — the host's later
action wins outright rather than being partially overwritten.

Test: snapshot the version, `SET_MODE` (bumping it), then `acceptScenePlan` with the stale snapshot —
dropped, mode stays what the host chose, `scenePlan` stays `null`. A second `acceptScenePlan` using the
*current* version still applies normally.

Root `bun run typecheck && bun run test`: green, 168 tests (29 protocol, 85 sync-client, 54 server).
