// Track library loaded from fixtures/tracks/<id>/meta.json; mirrors packages/protocol/src/mock-server.ts
// loadLibrary. Entries are stored without `urls` — those are built per-request from the request's own
// origin (buildTrackUrls), so the same binary serves http://localhost:8080 and https://<app>.fly.dev
// with no configured base (engine's R-1 review of the old apps/server implementation).
import { STEMS, type TrackLibraryEntry } from "@hive/protocol";

export type LibraryEntry = Omit<TrackLibraryEntry, "urls">;

export async function loadLibrary(fixturesDir: string): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
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
        energy: meta.energy,
        clickTimesSec: meta.clickTimesSec,
        dropSec: meta.dropSec,
        generated: meta.generated,
      });
    }
  } catch {
    /* no fixtures dir yet: fall through to the placeholder below */
  }
  if (out.length === 0) {
    out.push({ id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: [...STEMS], bpm: 120, generated: true });
  }
  return out;
}

export function buildTrackUrls(entry: LibraryEntry, origin: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const s of entry.stems) urls[s] = `${origin}/audio/${entry.id}/${s}.wav`;
  return urls;
}

export function withUrls(entry: LibraryEntry, origin: string): TrackLibraryEntry {
  return { ...entry, urls: buildTrackUrls(entry, origin) };
}
