/**
 * Track library: one entry per `fixtures/tracks/<id>/meta.json`. Loaded once at boot and refreshed
 * lazily so `bun run fixtures` in another terminal shows up without a restart.
 *
 * `urls` is built per request from the caller's own origin, so the same server works on
 * http://localhost:8080 and https://<app>.fly.dev without a configured base URL.
 */
import { STEMS, type TrackInfo, type TrackLibraryEntry } from "@hive/protocol";

/** meta.json as fixtures/gen-synthetic.ts writes it (urls are derived, never stored). */
export interface TrackMeta {
  id: string;
  title: string;
  durationSec: number;
  stems: string[];
  bpm?: number;
  energy?: number[];
  clickTimesSec?: number[];
  dropSec?: number;
  generated?: boolean;
}

const FALLBACK: TrackMeta = {
  id: "synthetic-60s",
  title: "Synthetic 60",
  durationSec: 60,
  stems: [...STEMS],
  bpm: 120,
  generated: true,
};

export class TrackLibrary {
  private tracks: TrackMeta[] = [];
  constructor(private readonly fixturesDir: string) {}

  async load(): Promise<TrackMeta[]> {
    const out: TrackMeta[] = [];
    const glob = new Bun.Glob("*/meta.json");
    try {
      for await (const rel of glob.scan({ cwd: `${this.fixturesDir}/tracks` })) {
        try {
          const meta = (await Bun.file(`${this.fixturesDir}/tracks/${rel}`).json()) as TrackMeta;
          if (meta && typeof meta.id === "string" && Array.isArray(meta.stems)) out.push(meta);
        } catch {
          /* a half-written meta.json is skipped, not fatal */
        }
      }
    } catch {
      /* no fixtures dir at all */
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    this.tracks = out.length > 0 ? out : [FALLBACK];
    return this.tracks;
  }

  all(): TrackMeta[] {
    return this.tracks;
  }

  find(id: string): TrackMeta | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  /** `TrackInfo` is the slice that goes into RoomState (no energy arrays on the hot path). */
  info(id: string): TrackInfo | undefined {
    const t = this.find(id);
    return t ? { id: t.id, title: t.title, durationSec: t.durationSec, stems: t.stems, bpm: t.bpm } : undefined;
  }

  /** Library response for `GET /tracks?q=`, with absolute stem URLs rooted at `origin`. */
  entries(origin: string, q = ""): TrackLibraryEntry[] {
    const needle = q.trim().toLowerCase();
    return this.tracks
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle))
      .map((t) => {
        const urls: Record<string, string> = {};
        for (const s of t.stems) urls[s] = `${origin}/audio/${t.id}/${s}.wav`;
        return {
          id: t.id,
          title: t.title,
          durationSec: t.durationSec,
          stems: t.stems,
          bpm: t.bpm,
          urls,
          energy: t.energy,
          clickTimesSec: t.clickTimesSec,
          generated: t.generated,
        };
      });
  }

  /** Absolute path of one stem's WAV, or null when the id/stem is unknown to the library. */
  stemPath(trackId: string, stem: string): string | null {
    const t = this.find(trackId);
    if (!t || !t.stems.includes(stem)) return null;
    return `${this.fixturesDir}/tracks/${trackId}/${stem}.wav`;
  }
}
