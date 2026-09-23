// Track library loaded from fixtures/tracks/<id>/meta.json; mirrors packages/protocol/src/mock-server.ts
// loadLibrary. Entries are stored without `urls` — those are built per-request from the request's own
// origin (buildTrackUrls), so the same binary serves http://localhost:8080 and https://<app>.fly.dev
// with no configured base (engine's R-1 review of the old apps/server implementation).
import { STEMS, type TrackLibraryEntry } from "@hive/protocol";

export type LibraryEntry = Omit<TrackLibraryEntry, "urls">;

export async function loadLibrary(fixturesDir: string): Promise<LibraryEntry[]> {
  const out: Array<LibraryEntry & { _order: number }> = [];
  const glob = new Bun.Glob("*/meta.json");
  try {
    for await (const rel of glob.scan({ cwd: `${fixturesDir}/tracks` })) {
      const meta = await Bun.file(`${fixturesDir}/tracks/${rel}`).json();
      out.push({
        id: meta.id,
        title: meta.title,
        durationSec: meta.durationSec,
        stems: meta.stems,
        bpm: meta.bpm,
        beatOffsetSec: meta.beatOffsetSec,
        energy: meta.energy,
        clickTimesSec: meta.clickTimesSec,
        dropSec: meta.dropSec,
        generated: meta.generated,
        // Sort key only, never sent to clients: meta.json can pin a track to the top of the
        // picker with "order": 0 (real music above the synthetic fixtures). Glob scan order is
        // filesystem-dependent, so without this the list order is whatever the OS feels like.
        _order: typeof meta.order === "number" ? meta.order : Number.MAX_SAFE_INTEGER,
      });
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
