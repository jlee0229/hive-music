// Track library loaded from fixtures/tracks/<id>/meta.json; mirrors packages/protocol/src/mock-server.ts loadLibrary.
import { STEMS, type TrackLibraryEntry } from "@hive/protocol";

export async function loadLibrary(fixturesDir: string, origin: string): Promise<TrackLibraryEntry[]> {
  const out: TrackLibraryEntry[] = [];
  const glob = new Bun.Glob("*/meta.json");
  try {
    for await (const rel of glob.scan({ cwd: `${fixturesDir}/tracks` })) {
      const meta = await Bun.file(`${fixturesDir}/tracks/${rel}`).json();
      const urls: Record<string, string> = {};
      for (const s of meta.stems as string[]) urls[s] = `${origin}/audio/${meta.id}/${s}.wav`;
      out.push({
        id: meta.id,
        title: meta.title,
        durationSec: meta.durationSec,
        stems: meta.stems,
        bpm: meta.bpm,
        urls,
        energy: meta.energy,
        clickTimesSec: meta.clickTimesSec,
        generated: meta.generated,
      });
    }
  } catch {
    /* no fixtures dir yet: fall through to the placeholder below */
  }
  if (out.length === 0) {
    const urls: Record<string, string> = {};
    for (const s of STEMS) urls[s] = `${origin}/audio/synthetic-60s/${s}.wav`;
    out.push({ id: "synthetic-60s", title: "Synthetic 60", durationSec: 60, stems: [...STEMS], bpm: 120, urls, generated: true });
  }
  return out;
}
