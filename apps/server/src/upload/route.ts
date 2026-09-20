// POST /tracks (B9): bring-your-own-stems upload. Multipart form fields:
//   title: string
//   hostKey: string  (must match the current hostKey of some room in this process — host-only)
//   drums / bass / vocals / other: WAV files (1-4 of them), OR
//   mix: a single WAV file (mutually exclusive with the four named stems)
// Every file is parsed, downmixed to mono, resampled to 44100 Hz and re-encoded as 16-bit PCM
// (apps/server/src/upload/{wav,convert}.ts — pure TS, no ffmpeg). meta.json is computed the way
// fixtures/gen-synthetic.ts computes it for the synthetic track. Fly's disk is ephemeral: uploads
// vanish on the next deploy unless a `fly volumes` mount is added (see docs/09-deploy.md).
import { STEMS, TrackInfoSchema, type TrackLibraryEntry } from "@hive/protocol";
import { z } from "zod";
import { alignStemLengths, normalizeStem, type NormalizedStem } from "./convert";
import { encodeMonoWav16 } from "./wav";
import { buildTrackMeta } from "./meta";
import { buildTrackUrls, type LibraryEntry } from "../library";
import type { RoomManager } from "../rooms";

const STEM_FIELDS = [...STEMS, "mix"] as const;
const MAX_TITLE_LEN = TrackInfoSchema.shape.title.maxLength ?? 120;

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "upload"}-${crypto.randomUUID().slice(0, 8)}`;
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

export async function handleUploadTracks(req: Request, manager: RoomManager, fixturesDir: string, origin: string, corsHeaders: Record<string, string>): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected multipart/form-data" }, 400, corsHeaders);
  }

  const hostKey = form.get("hostKey");
  if (typeof hostKey !== "string" || !manager.isKnownHostKey(hostKey)) {
    return json({ error: "NOT_HOST", message: "a valid hostKey is required to upload a track" }, 403, corsHeaders);
  }

  const rawTitle = form.get("title");
  const title = z.string().min(1).max(MAX_TITLE_LEN).safeParse(rawTitle);
  if (!title.success) return json({ error: `title must be 1-${MAX_TITLE_LEN} characters` }, 400, corsHeaders);

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
  const normalized: NormalizedStem[] = [];
  for (const [name, f] of entries) {
    try {
      const buf = new Uint8Array(await (f as File).arrayBuffer());
      normalized.push(normalizeStem(buf));
    } catch (e) {
      return json({ error: `stem '${name}': ${e instanceof Error ? e.message : "could not be parsed as WAV"}` }, 400, corsHeaders);
    }
  }
  alignStemLengths(normalized);

  const id = slugify(title.data);
  const trackDir = `${fixturesDir}/tracks/${id}`;
  await Promise.all(stemNames.map((name, i) => Bun.write(`${trackDir}/${name}.wav`, encodeMonoWav16(normalized[i]!.samples, normalized[i]!.sampleRate))));
  const meta = buildTrackMeta(id, title.data, stemNames, normalized);
  await Bun.write(`${trackDir}/meta.json`, JSON.stringify(meta, null, 2) + "\n");

  await manager.reloadLibrary();
  const entry: LibraryEntry = { id: meta.id, title: meta.title, durationSec: meta.durationSec, stems: meta.stems, energy: meta.energy, dropSec: meta.dropSec, generated: false };
  const track: TrackLibraryEntry = { ...entry, urls: buildTrackUrls(entry, origin) };
  return json({ track }, 201, corsHeaders);
}
