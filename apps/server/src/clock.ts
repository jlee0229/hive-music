/**
 * The master clock. Every server time on the wire comes from here.
 * `performance.timeOrigin + performance.now()` is monotonic within the process, so a wall-clock
 * step (NTP on the host, a container migration) never moves the room timeline. Never `Date.now()`.
 */
export const serverNow = (): number => performance.timeOrigin + performance.now();
