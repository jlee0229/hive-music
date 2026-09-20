# A resync during STROBE played the phone at full volume

date: 2026-09-20 · tests: 2 new (`drift.test.ts`, "a resync during a pattern") · verified failing before the fix
cmd: `bun test packages/sync-client/src/__tests__/drift.test.ts` · full gate `37 · 126 · 22`, 0 fail

## The bug

A hard resync builds a whole new branch and crossfades onto it. The new branch has its own `patternGain`,
and a fresh gain node starts at **1** — full volume. `startBranch` already re-armed the automation for
exactly this reason, with a comment saying so:

```ts
this.branches.push(branch);
// A new branch needs its own curve even when the pattern object is unchanged.
this.startPatternAutomation(assignment?.pattern ?? null, { restart: true });
```

But `writePatternWindow` resolved "the branch" itself, as `this.branches.find((b) => !b.stopped)` — and
during a resync the **old** branch is still un-stopped at that moment, because the crossfade needs it. It
is also *first* in the array. So the restart wrote the curve onto the branch that was about to fade out,
and the new one was left at a flat 1.

The next automation tick (100 ms) then wrote from `patternWrittenUntilMs`, which the restart had just
pushed up to 200 ms ahead — so the fresh node stayed unautomated until the music reached that position.
**Up to `PATTERN_LOOKAHEAD_MS` = 200 ms of full-volume audio through the correction**, and during STROBE's
silent half that is not a subtle artefact: it is one phone shouting a 200 ms burst in a gap.

The fix names the branch instead of searching for it:

```ts
this.startPatternAutomation(assignment?.pattern ?? null, { restart: true, branch });
…
private writePatternWindow(pattern: Pattern, target?: Branch): void {
  const branch = target ?? this.branches.find((b) => !b.stopped);
  if (!branch || branch.stopped) return;
```

## Why it survived the B5e tests

Every pattern test until now exercised the *first* branch, where "the live branch" and "the branch I just
built" are the same object. The bug needs two branches to exist at once, which happens only during a
crossfade — so it needed a test that resyncs **while a pattern is running**, and that intersection had no
coverage: `modes.test.ts` tested patterns without drift, `drift.test.ts` tested drift without patterns.
The new tests sit in the intersection and assert on the nodes created *by* the resync:

```ts
const fresh = rig.ctx.gains.slice(gainsBefore);
const curves = fresh.flatMap((g) => g.gain.events.filter((e) => e.kind === "setValueCurve"));
expect(curves.length).toBeGreaterThan(0);   // 0 before the fix
```

and that the curve is the pattern rather than a flat line (a strobe crosses 0.5 within one period), and
that its start time is never in the past — `setValueCurveAtTime` throws on a past time, and a curve
scheduled late is silently just a flat gain, which is the same failure wearing a different hat.

## The general lesson, third time this session

The engine keeps getting caught by **"the live X" resolved implicitly at a moment when there are two**.
P0-4 was two sockets where the code assumed one. The stale-close bug was the server resolving "this
client's socket" by id while two existed. This is the scheduler resolving "the live branch" while two
existed, during the 20 ms in which that is *by design* true. Where a function builds a thing and then
configures it, it should pass the thing.

## 🟡 Needs a human (phones)

1. Put the room in STROBE and force a resync on one phone — the easy way is a +30 ms nudge on the slider,
   which exceeds `RESYNC_THRESHOLD_MS` and crossfades. Before this fix that phone barked once during a
   silent phase. Now it should stay on the pattern through the correction.
2. Same in WAVE: a resync must not make one phone jump to full while the swell says it should be quiet.
3. Worth doing with slewing **off** (`/diag` → `slewEnabled`), because slewing now absorbs most of the
   errors that used to cause crossfades — which is good for the demo and bad for exercising this path.
