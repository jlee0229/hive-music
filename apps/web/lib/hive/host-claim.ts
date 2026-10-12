/**
 * What the host page should conclude from asking the server for a room's host key
 * (POST /rooms {code}). Kept apart from the page so it is unit-tested, and written to hold under
 * both server contracts: today's (an existing room hands its key to any caller; an unknown code is
 * a 400) and the one that replaces it (a caller without the key is refused, or answered without one).
 */
export type HostClaim =
  | { kind: "ok"; code: string; hostKey: string }
  /** The room does not exist any more: the server restarted, or the hive sat empty past its timeout. */
  | { kind: "ended" }
  /** The room exists and this phone is not allowed to host it. */
  | { kind: "elsewhere" }
  /** No answer worth trusting (offline, server down, 5xx) — worth another try. */
  | { kind: "unreachable" };

/** `status` is null when the request itself failed (network error, CORS, timeout). */
export function classifyHostClaim(status: number | null, body: unknown): HostClaim {
  if (status === null) return { kind: "unreachable" };
  if (status >= 200 && status < 300) {
    const b = (body ?? {}) as { code?: unknown; hostKey?: unknown };
    if (typeof b.code === "string" && typeof b.hostKey === "string" && b.hostKey.length > 0) return { kind: "ok", code: b.code, hostKey: b.hostKey };
    // A 2xx with no key: the room is there, the key is not ours to have.
    return { kind: "elsewhere" };
  }
  if (status === 400 || status === 404 || status === 410) return { kind: "ended" };
  if (status === 401 || status === 403 || status === 409) return { kind: "elsewhere" };
  return { kind: "unreachable" };
}
