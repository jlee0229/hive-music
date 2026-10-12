// POST /tracks (B9): bring-your-own-stems upload. Multipart form fields:
//   title: string
//   hostKey: string  (must match the current hostKey of some room in this process — host-only).
//            May also be sent as `Authorization: Bearer <hostKey>`, which is checked before the body
//            is read at all.
//   drums / bass / vocals / other: WAV files (1-4 of them), OR
//   mix: a single WAV file (mutually exclusive with the four named stems)
// Every file is parsed, downmixed to mono, resampled to 44100 Hz and re-encoded as 16-bit PCM
// (apps/server/src/upload/{wav,convert}.ts — pure TS, no ffmpeg). meta.json is computed the way
// fixtures/gen-synthetic.ts computes it for the synthetic track. Fly's disk is ephemeral: uploads
// vanish on the next deploy unless a `fly volumes` mount is added (see docs/09-deploy.md).
//
// Resource limits (audit SG-07). This handler runs in the same process, on the same thread and in
// the same heap as every live room, so an upload that exhausts memory or disk ends every party:
//   - the request body is capped (MAX_UPLOAD_BYTES) and refused from Content-Length before it is read;
//   - at most MAX_BUFFERED_UPLOADS bodies are held at once, and the memory-heavy stage (decode →
//     Float32 → analyse → encode) runs for one upload at a time;
//   - the library has a byte quota well under the volume size, checked before anything is written;
//   - a failed upload leaves nothing behind, and meta.json appears atomically, last.
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { STEMS, TrackInfoSchema, type TrackLibraryEntry } from "@hive/protocol";
import { alignStemLengths, normalizeStem, type NormalizedStem } from "./convert";
import { writeMonoWav16 } from "./wav";
import { buildTrackMeta } from "./meta";
import { buildTrackUrls, type LibraryEntry } from "../library";
import type { RoomManager } from "../rooms";

const STEM_FIELDS = [...STEMS, "mix"] as const;
const MAX_TITLE_LEN = TrackInfoSchema.shape.title.maxLength ?? 120;
const MIB = 1024 * 1024;

/** Whole request body. The web client's largest upload is a 600 s mono 16-bit 44.1 kHz WAV: 52.9 MB. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 64) * MIB;
/** Everything under fixtures/tracks. Production mounts a 1 GB volume there; leave room for the rest. */
export const LIBRARY_QUOTA_BYTES = Number(process.env.LIBRARY_QUOTA_MB ?? 800) * MIB;
/** A "track" shorter than this is a mistake or an attack: durationSec 0 fails TrackInfoSchema on every phone. */
export const MIN_TRACK_SEC = 1;
const MAX_BUFFERED_UPLOADS = 2;

let buffered = 0;
let lastJob: Promise<unknown> = Promise.resolve();
/** Runs `job` after every earlier job has settled: one upload in the decode/analyse/encode stage at a time. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = lastJob.then(job, job);
  lastJob = run.catch(() => {});
  return run;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "upload"}-${crypto.randomUUID().slice(0, 8)}`;
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders, ...extra } });
}

/** Bytes used by every file under fixtures/tracks (two levels: <id>/<file>). Missing directory → 0. */
export async function librarySizeBytes(fixturesDir: string): Promise<number> {
  const root = `${fixturesDir}/tracks`;
  let total = 0;
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(`${root}/${dir.name}`).catch(() => [])) {
      total += await stat(`${root}/${dir.name}/${name}`).then(
        (s) => (s.isFile() ? s.size : 0),
        () => 0,
      );
    }
  }
  return total;
}

export interface UploadLimits {
  maxUploadBytes: number;
  libraryQuotaBytes: number;
}

export async function handleUploadTracks(
  req: Request,
  manager: RoomManager,
  fixturesDir: string,
  origin: string,
  corsHeaders: Record<string, string>,
  limits: UploadLimits = { maxUploadBytes: MAX_UPLOAD_BYTES, libraryQuotaBytes: LIBRARY_QUOTA_BYTES },
): Promise<Response> {
  const tooLarge = () => json({ error: `upload is too large — the limit is ${Math.round(limits.maxUploadBytes / MIB)} MB` }, 413, corsHeaders);
  const notHost = () => json({ error: "NOT_HOST", message: "a valid hostKey is required to upload a track" }, 403, corsHeaders);

  // Everything that can be refused without reading the body is refused first.
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (declared > limits.maxUploadBytes) return tooLarge();
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S{1,64})$/i)?.[1];
  if (req.headers.has("authorization") && !(bearer && manager.isKnownHostKey(bearer))) return notHost();
  if (buffered >= MAX_BUFFERED_UPLOADS) {
    return json({ error: "another song is being added right now — try again in a moment" }, 503, corsHeaders, { "Retry-After": "5" });
  }

  buffered++;
  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "expected multipart/form-data" }, 400, corsHeaders);
    }

    const hostKey = bearer ?? form.get("hostKey");
    if (typeof hostKey !== "string" || !manager.isKnownHostKey(hostKey)) return notHost();

    const rawTitle = form.get("title");
    // Control characters have no business in a title that every host's song list renders.
    const title = typeof rawTitle === "string" ? rawTitle.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim() : "";
    if (title.length < 1 || title.length > MAX_TITLE_LEN) return json({ error: `title must be 1-${MAX_TITLE_LEN} characters` }, 400, corsHeaders);

    const mixFile = form.get("mix");
    const namedFiles = STEMS.map((s) => [s, form.get(s)] as const).filter(([, f]) => f !== null);
    if (mixFile && namedFiles.length > 0) {
      return json({ error: "upload either a single 'mix' file or 1-4 named stems (drums/bass/vocals/other), not both" }, 400, corsHeaders);
    }
    const entries: Array<readonly [string, FormDataEntryValue | null]> = mixFile ? [["mix", mixFile]] : namedFiles;
    if (entries.length === 0) {
      return json({ error: `no stems uploaded — use field names: ${STEM_FIELDS.join(", ")}` }, 400, corsHeaders);
    }
    for (const [name, f] of entries) {
      if (!(f instanceof File)) return json({ error: `field '${name}' must be a file` }, 400, corsHeaders);
    }
    const stemNames = entries.map(([name]) => name);

    return await exclusive(async () => {
      const normalized: NormalizedStem[] = [];
      for (const [name, f] of entries) {
        try {
          normalized.push(normalizeStem(new Uint8Array(await (f as File).arrayBuffer())));
        } catch (e) {
          // parseWav's own messages are written for the uploader; anything else (a RangeError from
          // a hostile header, say) is not something to echo back.
          const known = e instanceof Error && e.constructor === Error;
          return json({ error: `stem '${name}': ${known ? (e as Error).message : "could not be parsed as WAV"}` }, 400, corsHeaders);
        }
      }
      alignStemLengths(normalized);
      if (normalized[0]!.durationSec < MIN_TRACK_SEC) return json({ error: `that is under ${MIN_TRACK_SEC} second of audio` }, 400, corsHeaders);

      const needed = normalized.reduce((sum, s) => sum + 44 + s.samples.length * 2, 0);
      if ((await librarySizeBytes(fixturesDir)) + needed > limits.libraryQuotaBytes) {
        return json({ error: "the song library is full — no more songs can be added right now" }, 507, corsHeaders);
      }

      const id = slugify(title);
      const trackDir = `${fixturesDir}/tracks/${id}`;
      try {
        await mkdir(trackDir, { recursive: true });
        for (let i = 0; i < stemNames.length; i++) await writeMonoWav16(`${trackDir}/${stemNames[i]}.wav`, normalized[i]!.samples, normalized[i]!.sampleRate);
        const meta = buildTrackMeta(id, title, stemNames, normalized);
        // meta.json is what makes a directory a track (library.ts globs for it). Written last and
        // renamed into place, a crash at any point leaves either a complete track or none.
        await Bun.write(`${trackDir}/meta.json.tmp`, JSON.stringify(meta, null, 2) + "\n");
        await rename(`${trackDir}/meta.json.tmp`, `${trackDir}/meta.json`);

        await manager.reloadLibrary();
        const entry: LibraryEntry = { id: meta.id, title: meta.title, durationSec: meta.durationSec, stems: meta.stems, bpm: meta.bpm, beatOffsetSec: meta.beatOffsetSec, energy: meta.energy, dropSec: meta.dropSec, generated: false };
        const track: TrackLibraryEntry = { ...entry, urls: buildTrackUrls(entry, origin) };
        return json({ track }, 201, corsHeaders);
      } catch (e) {
        await rm(trackDir, { recursive: true, force: true }).catch(() => {});
        console.warn(`[hive-server] upload ${id} failed:`, e instanceof Error ? e.message : e);
        return json({ error: "the song could not be saved — try again" }, 507, corsHeaders);
      }
    });
  } finally {
    buffered--;
  }
}
