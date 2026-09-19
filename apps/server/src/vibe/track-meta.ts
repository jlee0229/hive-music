// dropSec lives in fixtures/tracks/<id>/meta.json but isn't on TrackLibraryEntrySchema (see
// docs/PROTOCOL-REQUESTS.md R-1): read it directly from the fixture file rather than over the wire.
export async function readDropSec(fixturesDir: string, trackId: string): Promise<number | undefined> {
  try {
    const meta = (await Bun.file(`${fixturesDir}/tracks/${trackId}/meta.json`).json()) as { dropSec?: number };
    return typeof meta.dropSec === "number" ? meta.dropSec : undefined;
  } catch {
    return undefined;
  }
}
