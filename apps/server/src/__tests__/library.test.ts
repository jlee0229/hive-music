import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackLibraryResponseSchema } from "@hive/protocol";
import { loadLibrary, withUrls } from "../library";

/**
 * Audit SG-08. loadLibrary wrapped its whole directory scan in one try/catch, so a single
 * truncated meta.json (a crash or OOM kill mid-write — Bun.write is not atomic) aborted the scan and
 * silently hid every track the filesystem listed after it; and it copied meta.json fields into
 * the library unvalidated, from where they go verbatim into ROOM_STATE.
 */
const roots: string[] = [];
const tempFixtures = () => {
  const d = mkdtempSync(join(tmpdir(), "hive-library-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("SG-08: the library loader treats meta.json as input", () => {
  const meta = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id, title: `Title ${id}`, durationSec: 30, sampleRate: 44100, stems: ["mix"], generated: false, ...extra });
  function library(files: Record<string, string>) {
    const fixtures = tempFixtures();
    for (const [dir, content] of Object.entries(files)) {
      mkdirSync(join(fixtures, "tracks", dir), { recursive: true });
      writeFileSync(join(fixtures, "tracks", dir, "meta.json"), content);
    }
    return loadLibrary(fixtures);
  }

  test("truncated / non-object meta.json files are skipped; every good track around them is still listed", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      files[`bad-${String(i).padStart(2, "0")}`] = ['{"id":"x","title":"cut off mid-wri', "", "null", "[]", '"a string"', "{}"][i % 6]!;
      files[`good-${String(i).padStart(2, "0")}`] = meta(`good-${String(i).padStart(2, "0")}`);
    }
    const lib = await library(files);
    expect(lib.map((t) => t.id).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `good-${String(i).padStart(2, "0")}`));
  });

  test("a track the wire schema would reject is not served; a bad optional field is dropped, not the track", async () => {
    const lib = await library({
      "zero-length": meta("zero-length", { durationSec: 0 }),
      "no-stems": meta("no-stems", { stems: [] }),
      "path-stem": meta("path-stem", { stems: ["../../secret"] }),
      "long-title": meta("long-title", { title: "t".repeat(121) }),
      "null-bpm": meta("null-bpm", { bpm: null, energy: [0.1, null, 0.3], dropSec: -4, beatOffsetSec: 0.25 }),
      "renamed-dir": meta("some-other-id", { bpm: 128, order: 0 }),
    });
    expect(lib.map((t) => t.id)).toEqual(["renamed-dir", "null-bpm"]); // order:0 first; the id is the directory
    const nullBpm = lib.find((t) => t.id === "null-bpm")!;
    expect(nullBpm).toEqual({ id: "null-bpm", title: "Title null-bpm", durationSec: 30, stems: ["mix"], beatOffsetSec: 0.25, generated: false });
    expect(TrackLibraryResponseSchema.safeParse(JSON.parse(JSON.stringify({ tracks: lib.map((t) => withUrls(t, "http://hive.test")) }))).success).toBe(true);
  });

  test("nothing loadable → the synthetic placeholder, as before", async () => {
    expect((await library({ "bad-only": "{" })).map((t) => t.id)).toEqual(["synthetic-60s"]);
    expect((await loadLibrary(join(tempFixtures(), "does-not-exist"))).map((t) => t.id)).toEqual(["synthetic-60s"]);
  });
});
