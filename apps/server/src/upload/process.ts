// The heavy half of POST /tracks: decode → mono → resample → align → analyse → encode → write.
// Pure work on bytes and files, no HTTP and no room state, so it can run either inline or — the
// default — in a short-lived Worker (worker.ts): on the request path it held the one event loop
// that also timestamps every room's NTP replies (SCALE-NET-04: 147 ms of silence for every party
// while a 3.5-minute song was being added, 270 ms for a 10-minute one).
import { mkdir, rename, rm } from "node:fs/promises";
import { alignStemLengths, normalizeStem, type NormalizedStem } from "./convert";
import { buildTrackMeta } from "./meta";
import { writeMonoWav16 } from "./wav";

/** A "track" shorter than this is a mistake or an attack: durationSec 0 fails TrackInfoSchema on every phone. */
export const MIN_TRACK_SEC = 1;

export interface UploadJob {
  id: string;
  title: string;
  /** Where the track goes: `<fixtures>/tracks/<id>`. */
  trackDir: string;
  /** Owner id to record in meta.json, or null for a shared track. */
  owner: string | null;
  stems: Array<{ name: string; bytes: Uint8Array }>;
  /** Bytes this upload may add before the library (quota, free space on the volume) is full. */
  roomInLibrary: number;
  /** Bytes this upload may add before its owner's allowance is used up; null when there is no owner. */
  roomForOwner: number | null;
}

export type UploadOutcome =
  | { ok: true }
  /** `refusal` is one of route.ts's coded refusals; otherwise `error` is a sentence for the uploader. */
  | { ok: false; status: number; error: string; refusal?: "library_full" | "owner_quota"; log: string };

export async function processUpload(job: UploadJob): Promise<UploadOutcome> {
  const normalized: NormalizedStem[] = [];
  for (const stem of job.stems) {
    try {
      normalized.push(normalizeStem(stem.bytes));
    } catch (e) {
      // parseWav's own messages are written for the uploader; anything else (a RangeError from a
      // hostile header, say) is not something to echo back.
      const known = e instanceof Error && e.constructor === Error;
      return { ok: false, status: 400, error: `stem '${stem.name}': ${known ? (e as Error).message : "could not be parsed as WAV"}`, log: `stem '${stem.name}' ${known ? (e as Error).message : "unparsable"}` };
    }
    stem.bytes = new Uint8Array(0); // the decoded samples are what matters from here on; let the upload's bytes go
  }
  alignStemLengths(normalized);
  if (normalized[0]!.durationSec < MIN_TRACK_SEC) return { ok: false, status: 400, error: `that is under ${MIN_TRACK_SEC} second of audio`, log: "under a second of audio" };

  const needed = normalized.reduce((sum, s) => sum + 44 + s.samples.length * 2, 0);
  if (needed > job.roomInLibrary) return { ok: false, status: 507, error: "library_full", refusal: "library_full", log: "library_full" };
  if (job.roomForOwner !== null && needed > job.roomForOwner) return { ok: false, status: 413, error: "owner_quota", refusal: "owner_quota", log: "owner_quota" };

  const stemNames = job.stems.map((s) => s.name);
  try {
    await mkdir(job.trackDir, { recursive: true });
    for (let i = 0; i < stemNames.length; i++) await writeMonoWav16(`${job.trackDir}/${stemNames[i]}.wav`, normalized[i]!.samples, normalized[i]!.sampleRate);
    const meta = buildTrackMeta(job.id, job.title, stemNames, normalized);
    // meta.json is what makes a directory a track (library.ts globs for it). Written last and
    // renamed into place, a crash at any point leaves either a complete track or none. `owner` ties
    // the track to the uploading browser; without one (LIBRARY_SCOPE=global and an old client) the
    // track is shared, as every upload was before.
    await Bun.write(`${job.trackDir}/meta.json.tmp`, JSON.stringify(job.owner ? { ...meta, owner: job.owner } : meta, null, 2) + "\n");
    await rename(`${job.trackDir}/meta.json.tmp`, `${job.trackDir}/meta.json`);
    return { ok: true };
  } catch (e) {
    await rm(job.trackDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, status: 507, error: "the song could not be saved — try again", log: `write failed: ${e instanceof Error ? e.message : e}` };
  }
}
