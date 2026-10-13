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
import { readdir, rm, stat, statfs } from "node:fs/promises";
import { STEMS, TrackInfoSchema } from "@hive/protocol";
import { processUpload, type UploadJob, type UploadOutcome } from "./process";
import { withUrls } from "../library";
import type { RoomManager } from "../rooms";

const STEM_FIELDS = [...STEMS, "mix"] as const;
const MAX_TITLE_LEN = TrackInfoSchema.shape.title.maxLength ?? 120;
const MIB = 1024 * 1024;

/** Whole request body. The web client's largest upload is a 600 s mono 16-bit 44.1 kHz WAV: 52.9 MB. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 64) * MIB;
/** Everything under fixtures/tracks. Production mounts a 1 GB volume there; leave room for the rest. */
export const LIBRARY_QUOTA_BYTES = Number(process.env.LIBRARY_QUOTA_MB ?? 800) * MIB;
/** Owned uploads (contracts/library-scope.md): what one browser may keep on the server. Shared tracks do not count. */
export const OWNER_MAX_TRACKS = 40;
export const OWNER_MAX_BYTES = 400 * MIB;
/** An upload is refused if it would leave the tracks volume with less free space than this. */
export const VOLUME_MIN_FREE_BYTES = 100 * MIB;
export { MIN_TRACK_SEC } from "./process";
const MAX_BUFFERED_UPLOADS = 2;

let buffered = 0;
let lastJob: Promise<unknown> = Promise.resolve();
/** Runs `job` after every earlier job has settled: one upload in the decode/analyse/encode stage at a time. */
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = lastJob.then(job, job);
  lastJob = run.catch(() => {});
  return run;
}

/**
 * Decode / analyse / encode / write one upload — in a Worker unless UPLOAD_WORKER=0. Inline, that
 * work held the event loop for every room on the server (147 ms for a 3.5-minute song, 270 ms for
 * ten minutes; a PLAY issued inside that window starts late). The worker gets the upload's bytes
 * by transfer, not by copy, and is terminated when it answers, which hands its whole heap back.
 */
const UPLOAD_IN_WORKER = process.env.UPLOAD_WORKER !== "0";
const UPLOAD_WORKER_TIMEOUT_MS = 120_000;
function runUpload(job: UploadJob): Promise<UploadOutcome> {
  if (!UPLOAD_IN_WORKER) return processUpload(job);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url).href);
  } catch {
    return processUpload(job); // no worker on this runtime: slower for the rooms, but the upload still lands
  }
  return new Promise((resolve) => {
    const finish = (outcome: UploadOutcome) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const failed = (log: string): UploadOutcome => ({ ok: false, status: 507, error: "the song could not be saved — try again", log });
    const timer = setTimeout(() => finish(failed("worker timed out")), UPLOAD_WORKER_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<UploadOutcome>) => finish(event.data);
    worker.onerror = (event) => finish(failed(`worker error: ${event.message}`));
    worker.postMessage(
      job,
      job.stems.map((stem) => stem.bytes.buffer as ArrayBuffer),
    );
  });
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

/** Bytes used under fixtures/tracks, per track directory (two levels: <id>/<file>). Missing directory → empty. */
export async function libraryUsage(fixturesDir: string): Promise<Map<string, number>> {
  const root = `${fixturesDir}/tracks`;
  const usage = new Map<string, number>();
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    let total = 0;
    for (const name of await readdir(`${root}/${dir.name}`).catch(() => [])) {
      total += await stat(`${root}/${dir.name}/${name}`).then(
        (s) => (s.isFile() ? s.size : 0),
        () => 0,
      );
    }
    usage.set(dir.name, total);
  }
  return usage;
}

/** Bytes used by every file under fixtures/tracks. */
export async function librarySizeBytes(fixturesDir: string): Promise<number> {
  let total = 0;
  for (const bytes of (await libraryUsage(fixturesDir)).values()) total += bytes;
  return total;
}

/** Free bytes on the volume that holds the tracks, or null where the platform cannot say. */
async function volumeFreeBytes(fixturesDir: string): Promise<number | null> {
  try {
    const s = await statfs(`${fixturesDir}/tracks`);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export interface UploadLimits {
  maxUploadBytes: number;
  libraryQuotaBytes: number;
  ownerMaxTracks?: number;
  ownerMaxBytes?: number;
  volumeMinFreeBytes?: number;
  /** Free space on the tracks volume; injectable so a test does not need a full disk. */
  volumeFreeBytes?: (fixturesDir: string) => Promise<number | null>;
}

/** Sentences the host page shows as they are; `error` is the stable code it switches on. */
const REFUSALS = {
  no_library: { status: 400, message: "Reload this page, then try again." },
  library_full: { status: 507, message: "The song library is full — no more songs can be added right now." },
  too_many_tracks: { status: 413, message: "You have reached the limit of songs you can add — remove one first." },
  owner_quota: { status: 413, message: "Your songs have used all the space you can have here — remove one first." },
} as const;

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
  const startedAt = performance.now();
  const sizeMb = Number.isNaN(Number(req.headers.get("content-length"))) ? "?" : (Number(req.headers.get("content-length")) / MIB).toFixed(1);
  const refuse = (code: keyof typeof REFUSALS) => {
    manager.log(`upload refused: ${code} (${sizeMb} MB)`);
    return json({ error: code, message: REFUSALS[code].message }, REFUSALS[code].status, corsHeaders);
  };
  const ownerMaxTracks = limits.ownerMaxTracks ?? OWNER_MAX_TRACKS;
  const ownerMaxBytes = limits.ownerMaxBytes ?? OWNER_MAX_BYTES;
  /** Whose upload this is, or the refusal: an owner-scoped library takes no upload from a room without an owner. */
  const ownerOf = (key: string): { owner: string | null } | Response => {
    const owner = manager.roomForHostKey(key)?.libraryOwner ?? null;
    if (owner === null && manager.libraryScope === "owner") return refuse("no_library");
    if (owner !== null && manager.getLibrary().filter((t) => t.owner === owner).length >= ownerMaxTracks) return refuse("too_many_tracks");
    return { owner };
  };

  // Everything that can be refused without reading the body is refused first.
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (declared > limits.maxUploadBytes) {
    manager.log(`upload refused: too large (${sizeMb} MB)`);
    return tooLarge();
  }
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S{1,64})$/i)?.[1];
  if (req.headers.has("authorization") && !(bearer && manager.isKnownHostKey(bearer))) return notHost();
  if (bearer) {
    const early = ownerOf(bearer);
    if (early instanceof Response) return early;
  }
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
    const who = ownerOf(hostKey);
    if (who instanceof Response) return who;
    const { owner } = who;

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
      // How much this upload may add, measured now that it is this upload's turn.
      const usage = await libraryUsage(fixturesDir);
      let used = 0;
      for (const bytes of usage.values()) used += bytes;
      const free = await (limits.volumeFreeBytes ?? volumeFreeBytes)(fixturesDir);
      const roomInLibrary = Math.min(limits.libraryQuotaBytes - used, free === null ? Infinity : free - (limits.volumeMinFreeBytes ?? VOLUME_MIN_FREE_BYTES));
      let roomForOwner: number | null = null;
      if (owner !== null) {
        // (re-checked here: this runs one upload at a time, the early check above does not)
        const mine = manager.getLibrary().filter((t) => t.owner === owner);
        if (mine.length >= ownerMaxTracks) return refuse("too_many_tracks");
        roomForOwner = ownerMaxBytes - mine.reduce((sum, t) => sum + (usage.get(t.id) ?? 0), 0);
      }

      const id = slugify(title);
      const trackDir = `${fixturesDir}/tracks/${id}`;
      const stems: UploadJob["stems"] = [];
      for (const [name, f] of entries) stems.push({ name, bytes: new Uint8Array(await (f as File).arrayBuffer()) });
      const outcome = await runUpload({ id, title, trackDir, owner, stems, roomInLibrary, roomForOwner });
      if (!outcome.ok) {
        await rm(trackDir, { recursive: true, force: true }).catch(() => {}); // whatever a failed attempt left
        if (outcome.refusal) return refuse(outcome.refusal);
        manager.log(`upload refused: ${outcome.log} (${sizeMb} MB)`);
        return json({ error: outcome.error }, outcome.status, corsHeaders);
      }

      await manager.reloadLibrary();
      // The entry as the library now holds it (validated on load), as this owner is allowed to see it.
      const entry = manager.getLibrary().find((t) => t.id === id);
      if (!entry) {
        await rm(trackDir, { recursive: true, force: true }).catch(() => {});
        manager.log(`upload refused: ${id} did not load back from disk (${sizeMb} MB)`);
        return json({ error: "the song could not be saved — try again" }, 507, corsHeaders);
      }
      manager.log(`upload accepted: ${id} — ${stemNames.length} stem(s), ${entry.durationSec.toFixed(1)} s of audio, ${sizeMb} MB, ${Math.round(performance.now() - startedAt)} ms${entry.bpm ? `, ${entry.bpm} BPM` : ""}`);
      return json({ track: withUrls(entry, origin, owner) }, 201, corsHeaders);
    });
  } finally {
    buffered--;
  }
}

/**
 * DELETE /tracks/:id — an owner removes one of their own uploads (contracts/library-scope.md).
 * `Authorization: Bearer <hostKey>` of a live room. What the caller may learn is deliberately
 * coarse: an id it cannot see (unknown, or another owner's) is 404 either way; a track it can see
 * but does not own (a shared one — or, under LIBRARY_SCOPE=global, anyone else's) is 403.
 */
export async function handleDeleteTrack(req: Request, id: string, manager: RoomManager, fixturesDir: string, corsHeaders: Record<string, string>): Promise<Response> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S{1,64})$/i)?.[1];
  const room = manager.roomForHostKey(bearer);
  if (!room) return json({ error: "NOT_HOST", message: "a valid hostKey is required to remove a track" }, 403, corsHeaders);
  const track = room.library().find((t) => t.id === id);
  if (!track) return json({ error: "not_found" }, 404, corsHeaders);
  if (track.owner === undefined || track.owner !== room.libraryOwner) return json({ error: "not_owner" }, 403, corsHeaders);
  if (manager.isTrackInUse(id)) return json({ error: "in_use", message: "That song is playing — pick another first." }, 409, corsHeaders);
  // `id` is a directory name the library loader accepted ([A-Za-z0-9_-]+): it cannot climb out of tracks/.
  await rm(`${fixturesDir}/tracks/${id}`, { recursive: true, force: true });
  await manager.reloadLibrary(); // every room's nextTrack follows (Room.onLibraryChanged)
  manager.log(`track removed by its owner: ${id}`);
  return json({ ok: true }, 200, corsHeaders);
}
