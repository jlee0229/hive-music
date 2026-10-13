// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { songSubtitle } from "./derive";
import { MAX_UPLOAD_SEC, UPLOAD_ERRORS, encodeWav16, titleFromFilename, uploadErrorMessage } from "./upload-track";

describe("encodeWav16", () => {
  test("writes the 44-byte mono 16-bit header POST /tracks parses, then little-endian samples", () => {
    const buf = encodeWav16(new Float32Array([0, 1, -1, 0.5, 2, -2]), 44100);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(buf.byteLength).toBe(44 + 12);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 12);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(88200);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(12);
    const samples = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true));
    // out-of-range input clips instead of wrapping around to the opposite sign
    expect(samples).toEqual([0, 32767, -32768, 16383, 32767, -32768]);
  });
});

describe("uploadErrorMessage", () => {
  test("no answer or a server error reads as a connection problem", () => {
    expect(uploadErrorMessage(0, null)).toBe(UPLOAD_ERRORS.network);
    expect(uploadErrorMessage(502, null)).toBe(UPLOAD_ERRORS.network);
  });
  test("rate limits, a busy server and a full library each get their own sentence, not 'check the connection'", () => {
    expect(uploadErrorMessage(429, { error: "rate_limited" })).toBe(UPLOAD_ERRORS.busy);
    expect(uploadErrorMessage(503, { error: "busy" })).toBe(UPLOAD_ERRORS.busy);
    expect(uploadErrorMessage(507, { error: "library full" })).toBe(UPLOAD_ERRORS.full);
    expect(uploadErrorMessage(507, null)).toBe(UPLOAD_ERRORS.full);
  });
  test("owned uploads: no_library asks for a reload; a full library and a quota refusal are one plain sentence each", () => {
    expect(uploadErrorMessage(400, { error: "no_library" })).toBe("Reload this page, then try again.");
    expect(uploadErrorMessage(507, { error: "library_full" })).toBe("The song library is full.");
    expect(uploadErrorMessage(413, { error: "library_full" })).toBe("The song library is full.");
    expect(uploadErrorMessage(413, { error: "quota", message: "You have 40 songs here already. Remove one first." })).toBe("You have 40 songs here already. Remove one first.");
    expect(uploadErrorMessage(413, { error: "body too large" })).toBe("body too large"); // a sentence from the server is shown as it is
    expect(uploadErrorMessage(413, { error: "TOO_BIG" })).toBe(UPLOAD_ERRORS.tooBig);
  });
  test("a refused host key is explained, never printed as NOT_HOST", () => {
    const msg = uploadErrorMessage(403, { error: "NOT_HOST", message: "a valid hostKey is required to upload a track" } as { error: string });
    expect(msg).toBe(UPLOAD_ERRORS.notHost);
    expect(msg).not.toMatch(/NOT_HOST|hostKey/);
  });
  test("a server validation sentence is passed through; a bare identifier is not", () => {
    expect(uploadErrorMessage(400, { error: "stem 'mix': not a RIFF/WAVE file" })).toBe("stem 'mix': not a RIFF/WAVE file");
    expect(uploadErrorMessage(400, { error: "BAD_REQUEST" })).toBe("the upload was refused (400)");
    expect(uploadErrorMessage(400, null)).toBe("the upload was refused (400)");
  });
});

describe("upload messages and titles", () => {
  test("the too-long message states the song's length, not a rounded '10 minutes — the limit is 10'", () => {
    expect(UPLOAD_ERRORS.tooLong(MAX_UPLOAD_SEC + 1)).toBe("that song is 10:01 long — the limit is 10 minutes");
    expect(UPLOAD_ERRORS.tooLong(3723)).toBe("that song is 62:03 long — the limit is 10 minutes");
  });
  test("titleFromFilename drops the extension, never returns an empty title, and respects the 120-char limit", () => {
    expect(titleFromFilename("01 - Baby [feat. Ludacris].mp3")).toBe("01 - Baby [feat. Ludacris]");
    expect(titleFromFilename(".mp3")).toBe("Uploaded track");
    expect(titleFromFilename("   .wav")).toBe("Uploaded track");
    expect(titleFromFilename(`${"x".repeat(300)}.m4a`).length).toBe(120);
  });
});

describe("songSubtitle", () => {
  test("an uploaded song is one stem: no '1 parts', and minutes:seconds rather than '213s'", () => {
    expect(songSubtitle({ stems: ["mix"], durationSec: 213.4 }, null)).toBe("3:33");
  });
  test("a stem song says how many parts; the loaded song says whether it is playing or waiting for Start", () => {
    expect(songSubtitle({ stems: ["drums", "bass", "vocals", "other"], durationSec: 60 }, "playing")).toBe("4 parts · 1:00 · playing");
    expect(songSubtitle({ stems: ["mix"], durationSec: 60 }, "next")).toBe("1:00 · up next");
  });
});
