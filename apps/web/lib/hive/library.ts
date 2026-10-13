/**
 * The host's view of the song library (contract: owned uploads). A hive lists the shared songs plus
 * the uploads owned by this browser; the server decides which those are from the host key that
 * every request here carries as `Authorization: Bearer`. The only ownership fact the page ever
 * sees is `mine: true` on its own uploads — which is what makes a song removable.
 */
import type { TrackLibraryEntry } from "@hive/protocol";

/** A library entry as the host page lists it (`mine` marks this browser's own uploads). */
export type LibraryTrack = TrackLibraryEntry;

/** GET /tracks as this hive's host. Throws on anything but a JSON list, so the caller can retry. */
export async function fetchLibrary(apiUrl: string, hostKey: string): Promise<LibraryTrack[]> {
  const res = await fetch(`${apiUrl}/tracks`, { headers: { Authorization: `Bearer ${hostKey}` } });
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { tracks?: LibraryTrack[] };
  if (!Array.isArray(body.tracks)) throw new Error("no track list");
  return body.tracks;
}

export type RemoveResult = "removed" | "in_use" | "not_allowed" | "failed";

/** What a DELETE /tracks/:id answer means. `status` 0 = the request never got an answer. */
export function classifyRemove(status: number, body: { error?: unknown } | null): RemoveResult {
  if (status >= 200 && status < 300) return "removed";
  if (status === 409 || body?.error === "in_use") return "in_use";
  // 403 not_owner (a shared song, or someone else's) and 404 (already gone / not visible) read the same to a host.
  if (status === 401 || status === 403 || status === 404) return "not_allowed";
  return "failed";
}

/** DELETE /tracks/:id as this hive's host. Never throws. */
export async function removeTrack(apiUrl: string, hostKey: string, trackId: string): Promise<RemoveResult> {
  try {
    const res = await fetch(`${apiUrl}/tracks/${encodeURIComponent(trackId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${hostKey}` } });
    return classifyRemove(res.status, (await res.json().catch(() => null)) as { error?: unknown } | null);
  } catch {
    return classifyRemove(0, null);
  }
}

/** The sentence the Songs drawer shows when a song was not removed; null when it was. */
export function removeErrorText(result: RemoveResult): string | null {
  switch (result) {
    case "removed":
      return null;
    case "in_use":
      return "That song is playing — pick another first.";
    case "not_allowed":
      return "That song can’t be removed.";
    case "failed":
      return "Couldn’t remove the song — try again.";
  }
}
