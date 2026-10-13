/**
 * A guest whose hive has gone missing under it (PARTY-01).
 *
 * The server forgets every room when it restarts, and the host's phone is what brings one back. A
 * guest that was already in the hive and is then told NO_ROOM is therefore usually a few seconds or a
 * few minutes early, not at a wrong address: it waits, asks again, and only gives up after a while.
 */

/** How long a phone that was in the hive keeps asking before it says "Hive not found". */
export const ROOM_LOST_GIVE_UP_MS = 5 * 60_000;

/**
 * The wait before retry number `attempt` (0 = the first): 5 s, 10 s, 20 s, then every 30 s.
 *
 * Gentle on purpose. Outside the server's restart grace window every refused JOIN counts against a
 * per-address budget (60 a minute, shared by every phone on the party's Wi-Fi), so a room full of
 * phones asking every few seconds would lock the whole address out for the rest of that minute —
 * including the minute the host comes back in. Spread upward by up to 20 % so phones that lost the
 * room in the same instant do not all ask in the same instant.
 */
export function rejoinDelayMs(attempt: number, random: () => number = Math.random): number {
  const nominal = Math.min(30_000, 5000 * 2 ** Math.min(Math.max(0, attempt), 3));
  return Math.round(nominal * (1 + 0.2 * random()));
}

/** True while a phone that lost its hive at `lostAtMs` should keep waiting for it. */
export function stillWaitingForRoom(lostAtMs: number, nowMs: number): boolean {
  return nowMs - lostAtMs < ROOM_LOST_GIVE_UP_MS;
}
