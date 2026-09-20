import { PROTOCOL_VERSION } from "@hive/protocol";

const RELOADED_FOR_KEY = "hive:protocolVersionReloadedFor";

/** GET /health on both the mock and the real server always reports the running protocolVersion. */
async function fetchServerProtocolVersion(apiUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${apiUrl}/health`);
    if (!res.ok) return null;
    const data = (await res.json()) as { protocolVersion?: unknown };
    return typeof data.protocolVersion === "number" ? data.protocolVersion : null;
  } catch {
    return null; // offline / CORS -- the WS connection itself will surface real connectivity problems
  }
}

export type ProtocolGuardResult = "ok" | "reloading" | "banner";

/**
 * Checks this bundle's PROTOCOL_VERSION against the server's before connecting. A mismatch reloads
 * the page once -- a stale service worker or CDN cache is the common cause, and one reload usually
 * picks up the matching bundle -- guarded by a sessionStorage flag keyed to *this* bundle's version,
 * so it can never loop: if the reloaded page still bundles the same version and still mismatches,
 * "banner" tells the caller to show a static notice instead of reloading again.
 */
export async function guardProtocolVersion(apiUrl: string): Promise<ProtocolGuardResult> {
  const serverVersion = await fetchServerProtocolVersion(apiUrl);
  if (serverVersion === null || serverVersion === PROTOCOL_VERSION) return "ok";

  let alreadyReloadedFor: string | null = null;
  try {
    alreadyReloadedFor = sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    /* private mode / no storage -- worst case this runs one avoidable extra reload */
  }
  if (alreadyReloadedFor === String(PROTOCOL_VERSION)) return "banner";

  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, String(PROTOCOL_VERSION));
  } catch {
    /* ignore -- reload still proceeds, it just loses the one-shot guard for this session */
  }
  window.location.reload();
  return "reloading";
}
