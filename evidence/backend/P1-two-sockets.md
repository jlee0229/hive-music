# Two sockets for one phone — the close that demotes the live connection

date: 2026-09-20 · tests: 3 new (2 mock server, 1 engine) · both verified to fail before the fix
cmd: `bun run typecheck && bun run test` → `@hive/protocol 37 · @hive/sync-client 121 · @hive/server 22`, 0 fail

Found by re-reading `transport.ts` adversarially after the reconnect-storm work. It is **two bugs, one
causing the other**, and the pair is silent from both ends — the phone stays connected and keeps playing
in sync while the server believes it is gone.

## Bug A (client) · a manual `connect()` left the backoff armed

`onclose` arms a retry at `reconnectDelayMs(attempt)`. `connect()` — which the player UI calls from
"Tap to resume" after every iOS interruption — did not cancel it. So a tap during the backoff opened a
socket, JOINed, and then the timer fired a few hundred milliseconds later, opened *another* socket, and
replaced the one that had just joined.

```ts
if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
```

P0-4 made `connect()` idempotent with respect to *live* sockets; this is the same invariant for *pending*
ones. One socket per transport has to mean one pending connect too.

The test has a detail worth keeping: the first version **passed against the broken code**, because it
called `connect()` in the same tick as the restart. At that moment `ws.readyState` is still `OPEN` as far
as the client knows, so `connect()` resolves immediately and the race never happens. It has to wait for
`connection === "reconnecting"` — i.e. for `onclose` to have armed the timer — and then tap inside the
300 ms window. With that, the count is **2 JOINs without the fix, 1 with it**.

## Bug B (server) · the orphan's close demoted the live connection

The mock's close handler was keyed by `clientId` alone:

```ts
close(ws) { const id = ws.data.clientId; if (id && room.clients[id]) { …connected = false; sockets.delete(id); } }
```

A phone can briefly have two sockets — bug A above, or simply a reconnect racing a retry on a bad network
— and the orphan's close arrives **after** the new socket has JOINed. That close then marked the client
disconnected and **deleted the live socket's registration**. Consequences, none of them visible as an
error:

- the phone shows as offline in the Hive Map for the rest of the set;
- it stops receiving anything *targeted*: no `SCHEDULED_ACTION`, so it never clicks during a tuning
  moment, and no `CALIBRATION_PLAN` if it is the reference;
- meanwhile it is still connected, still gets `ROOM_STATE` (a broadcast), and is still playing perfectly
  in sync. Every indicator on the phone is green.

```ts
if (sockets.get(id) !== ws) return; // a stale socket's close: the live one already replaced it
```

Only the socket we currently hold may demote its client. Verified failing before the fix (`connected` read
`false` after the orphan's close); the second test pins the other direction, that the *last* socket to
close really does mark the client offline, so the guard cannot be satisfied by never demoting anyone.

## Why this pair matters more than it looks

Bug A is the *cause* and bug B is the *amplifier*, and the engine cannot fix B for itself. A server must
not depend on clients never overlapping sockets, because on a bad network a close always races a JOIN —
that is the normal case, not the pathological one. So the fix belongs in both places, and R-10 in
`docs/PROTOCOL-REQUESTS.md` asks the real server for the same guard.

The shape is the recurring one in this engine's bug list: **nothing throws, nothing goes red, and the
failure is a capability quietly missing.** A phone that cannot receive a scheduled click looks identical to
a phone that was never asked to click.

## 🟡 Needs a human (phones)

1. With 4+ phones playing, lock and unlock one phone repeatedly, tapping "Tap to resume" as fast as the
   backoff allows. It must stay listed as online in the Hive Map, and a tuning moment started afterwards
   must include it in the click order.
2. Watch the host's Hive Map during a flaky-network moment (walk a phone out of range and back). A phone
   that comes back must not stay grey while its own screen shows green.
