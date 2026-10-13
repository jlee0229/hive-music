// Track library loaded from fixtures/tracks/<id>/meta.json; mirrors packages/protocol/src/mock-server.ts
// loadLibrary. Entries are stored without `urls` — those are built per-request from the request's own
// origin (buildTrackUrls), so the same binary serves http://localhost:8080 and https://<app>.fly.dev
// with no configured base (engine's R-1 review of the old apps/server implementation).
import { STEMS, TrackLibraryEntrySchema, type TrackLibraryEntry } from "@hive/protocol";

export type LibraryEntry = Omit<TrackLibraryEntry, "urls">;

const CoreSchema = TrackLibraryEntrySchema.pick({ title: true, durationSec: true, stems: true });
const OptionalSchema = TrackLibraryEntrySchema.pick({ bpm: true, beatOffsetSec: true, energy: true, clickTimesSec: true, dropSec: true, generated: true });
/** What GET /audio/:id/:stem.wav can actually serve (index.ts's route regex). */
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * One meta.json → one entry, or null if it cannot be a track.
 *
 * A meta.json is a file on a disk that survives crashes, so it is validated like input (audit
 * SG-08): everything here ends up verbatim in ROOM_STATE (`track`), where one field the schema
 * rejects — durationSec 0, `"bpm": null` — makes the snapshot unreadable on every phone in every
 * room that plays the song. A bad required field drops the track; a bad optional one drops the field.
 */
function toEntry(dirName: string, meta: unknown): (LibraryEntry & { _order: number }) | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const core = CoreSchema.safeParse(m);
  // The directory name is the id: it is what the audio URLs are built from, whatever meta.id says.
  if (!core.success || !URL_SAFE.test(dirName) || dirName.length > 64 || !core.data.stems.every((s) => URL_SAFE.test(s))) return null;
  const entry: LibraryEntry = { id: dirName, ...core.data };
  for (const key of Object.keys(OptionalSchema.shape) as Array<keyof typeof OptionalSchema.shape>) {
    if (m[key] === undefined || m[key] === null) continue;
    const field = OptionalSchema.shape[key].safeParse(m[key]);
    if (field.success) (entry as Record<string, unknown>)[key] = field.data;
  }
  // Sort key only, never sent to clients: meta.json can pin a track to the top of the picker with
  // "order": 0 (real music above the synthetic fixtures). Glob scan order is filesystem-dependent,
  // so without this the list order is whatever the OS feels like.
  return { ...entry, _order: typeof m.order === "number" && Number.isFinite(m.order) ? m.order : Number.MAX_SAFE_INTEGER };
}

export async function loadLibrary(fixturesDir: string): Promise<LibraryEntry[]> {
  const out: Array<LibraryEntry & { _order: number }> = [];
  const glob = new Bun.Glob("*/meta.json");
  try {
    for await (const rel of glob.scan({ cwd: `${fixturesDir}/tracks` })) {
      const dirName = rel.split(/[\\/]/)[0]!;
      // Per track, not around the whole scan: one truncated meta.json (a crash mid-write) used to
      // abort the loop and silently hide every track the filesystem happened to list after it.
      try {
        const entry = toEntry(dirName, await Bun.file(`${fixturesDir}/tracks/${rel}`).json());
        if (entry) out.push(entry);
        else console.warn(`[hive-server] library: skipping ${dirName} (meta.json is not a valid track)`);
      } catch (err) {
        console.warn(`[hive-server] library: skipping ${dirName} (meta.json unreadable: ${err instanceof Error ? err.message : err})`);
      }
    }
  } catch {
    /* no fixtures dir yet: fall through to the placeholder below */
  }
  out.sort((a, b) => a._order - b._order || a.title.localeCompare(b.title));
  if (out.length === 0) {
    return [{ id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: [...STEMS], bpm: 120, generated: true }];
  }
  return out.map(({ _order, ...entry }) => entry);
}

export function buildTrackUrls(entry: LibraryEntry, origin: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const s of entry.stems) urls[s] = `${origin}/audio/${entry.id}/${s}.wav`;
  return urls;
}

export function withUrls(entry: LibraryEntry, origin: string): TrackLibraryEntry {
  return { ...entry, urls: buildTrackUrls(entry, origin) };
}
