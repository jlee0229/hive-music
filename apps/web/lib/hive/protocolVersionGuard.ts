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
 * The decision, apart from the fetch and the reload so it can be unit-tested.
 *
 * A mismatch is worth exactly ONE reload (a stale cached bundle is the common cause), and the only
 * thing that makes it "one" is a flag that survives the reload. So the reload happens only if that
 * flag was actually written and can be read back. Where storage is blocked — Safari with all cookies
 * blocked, Chrome with site data blocked, some in-app webviews: `sessionStorage` throws or silently
 * drops the write — nothing would remember the reload, and the page used to reload again on every
 * load for as long as the mismatch lasted (the whole window between a web deploy and a server
 * deploy). There the answer is the banner, straight away.
 *
 * `getStorage` is a function because merely touching `window.sessionStorage` can throw.
 */
export function decideProtocolGuard(
  serverVersion: number | null,
  bundleVersion: number,
  getStorage: () => Pick<Storage, "getItem" | "setItem">,
): "ok" | "reload" | "banner" {
  if (serverVersion === null || serverVersion === bundleVersion) return "ok";
  const mark = String(bundleVersion);
  try {
    const storage = getStorage();
    if (storage.getItem(RELOADED_FOR_KEY) === mark) return "banner"; // already reloaded once for this bundle
    storage.setItem(RELOADED_FOR_KEY, mark);
    return storage.getItem(RELOADED_FOR_KEY) === mark ? "reload" : "banner";
  } catch {
    return "banner"; // storage blocked: a reload could not be told from the first load
  }
}

/**
 * Checks this bundle's PROTOCOL_VERSION against the server's before connecting. A mismatch reloads
 * the page once, guarded by a sessionStorage flag keyed to *this* bundle's version, so it can never
 * loop: if the reloaded page still bundles the same version and still mismatches — or the flag could
 * not be stored at all — "banner" tells the caller to show a static notice instead.
 */
export async function guardProtocolVersion(apiUrl: string): Promise<ProtocolGuardResult> {
  const decision = decideProtocolGuard(await fetchServerProtocolVersion(apiUrl), PROTOCOL_VERSION, () => window.sessionStorage);
  if (decision !== "reload") return decision;
  window.location.reload();
  return "reloading";
}
