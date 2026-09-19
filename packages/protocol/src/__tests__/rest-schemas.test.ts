/**
 * The REST schemas against the *real* fixture metadata.
 *
 * This test exists because of a bug it would have caught: `fixtures/gen-synthetic.ts` has written
 * `dropSec` into meta.json since IC0, `TrackLibraryEntrySchema` carried `energy` and `clickTimesSec` but
 * not `dropSec`, and zod strips unknown keys — so the Vibe Director could never see the drop over the
 * wire no matter what the server put in the JSON, and nothing failed. Parsing the actual file through
 * the actual schema is the only check that catches that class of drift.
 */
import { describe, expect, test } from "bun:test";
import {
  CreateRoomResponseSchema, HealthResponseSchema, RoomSummarySchema, TrackLibraryEntrySchema,
  TrackLibraryResponseSchema, VibeRequestSchema, VibeResponseSchema,
} from "../rest";
import { PROTOCOL_VERSION } from "../constants";

const META_PATH = `${import.meta.dir}/../../../../fixtures/tracks/synthetic-60s/meta.json`;

describe("REST schemas vs the fixture generator", () => {
  test("every field gen-synthetic.ts writes survives TrackLibraryEntrySchema", async () => {
    const meta = (await Bun.file(META_PATH).json()) as Record<string, unknown>;
    const urls: Record<string, string> = {};
    for (const s of meta.stems as string[]) urls[s] = `http://localhost:8080/audio/${meta.id}/${s}.wav`;

    const parsed = TrackLibraryEntrySchema.parse({ ...meta, urls });
    expect(parsed.id).toBe("synthetic-60s");
    expect(parsed.stems).toEqual(["drums", "bass", "vocals", "other"]);
    expect(parsed.bpm).toBe(120);
    expect(parsed.energy).toHaveLength(60);
    expect(parsed.clickTimesSec).toHaveLength(120);
    expect(parsed.dropSec).toBe(30); // the field R-1/R-2 added: the Vibe Director's anchor
    expect(parsed.generated).toBe(true);

    // Anything meta.json carries that the schema does not is silently dropped, so name the exceptions
    // rather than letting a new field go missing the way dropSec did.
    const knownToBeLocal = new Set(["sampleRate"]); // encoding detail, never on the wire
    const missing = Object.keys(meta).filter((k) => !(k in parsed) && !knownToBeLocal.has(k));
    expect(missing).toEqual([]);
  });

  test("the library response wraps entries", async () => {
    const meta = (await Bun.file(META_PATH).json()) as Record<string, unknown>;
    const urls = Object.fromEntries((meta.stems as string[]).map((s) => [s, `http://x/audio/x/${s}.wav`]));
    const res = TrackLibraryResponseSchema.parse({ tracks: [{ ...meta, urls }] });
    expect(res.tracks).toHaveLength(1);
    expect(TrackLibraryResponseSchema.parse({ tracks: [] }).tracks).toEqual([]);
  });

  test("dropSec is optional and rejects nonsense", () => {
    const base = { id: "t", title: "T", durationSec: 10, stems: ["mix"], urls: { mix: "http://x" } };
    expect(TrackLibraryEntrySchema.parse(base).dropSec).toBeUndefined();
    expect(TrackLibraryEntrySchema.parse({ ...base, dropSec: 0 }).dropSec).toBe(0);
    expect(TrackLibraryEntrySchema.safeParse({ ...base, dropSec: -1 }).success).toBe(false);
    expect(TrackLibraryEntrySchema.safeParse({ ...base, dropSec: "soon" }).success).toBe(false);
  });

  test("the other REST shapes round-trip", () => {
    expect(HealthResponseSchema.parse({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: 1 }).ok).toBe(true);
    expect(HealthResponseSchema.safeParse({ ok: false, protocolVersion: 1, serverTime: 1 }).success).toBe(false);
    expect(CreateRoomResponseSchema.parse({ code: "BZQ7", hostKey: "k", joinUrl: "http://x/j/BZQ7" }).code).toBe("BZQ7");
    expect(RoomSummarySchema.parse({ code: "BZQ7", players: 3, exists: true }).players).toBe(3);
    expect(VibeRequestSchema.safeParse({ prompt: "" }).success).toBe(false);
    expect(VibeRequestSchema.safeParse({ prompt: "x".repeat(501) }).success).toBe(false);
    expect(VibeRequestSchema.parse({ prompt: "calm then explode" }).prompt).toBe("calm then explode");
    const plan = { prompt: "p", source: "rules" as const, createdAtServerTime: 1, scenes: [{ atTrackSec: 0, mode: "UNISON" as const, params: {}, note: "open" }] };
    expect(VibeResponseSchema.parse({ scenePlan: plan }).scenePlan.scenes).toHaveLength(1);
  });
});
