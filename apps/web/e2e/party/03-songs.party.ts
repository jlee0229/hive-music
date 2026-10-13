import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./test";
import { API, Party, SOUND_RMS, makeWav, sleep } from "./harness";

/**
 * Scenario 3 — songs, through the real Songs drawer: upload (WAV, and MP3/M4A when ffmpeg is on
 * PATH), ownership (the uploader sees it with a remove control; a second host with its own browser
 * storage never sees it), play it on every guest, and remove it (refused while it is the room's
 * song, allowed after switching away).
 */

function ffmpegVariants(wav: Buffer): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  const out: Array<{ name: string; mimeType: string; buffer: Buffer }> = [];
  const dir = mkdtempSync(join(tmpdir(), "hive-party-ff-"));
  writeFileSync(join(dir, "in.wav"), wav);
  for (const [file, mimeType, args] of [
    ["Party Upload MP3.mp3", "audio/mpeg", ["-codec:a", "libmp3lame", "-b:a", "128k"]],
    ["Party Upload M4A.m4a", "audio/mp4", ["-codec:a", "aac", "-b:a", "128k"]],
  ] as const) {
    try {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "in.wav"), ...args, join(dir, file)], { stdio: "ignore", timeout: 30_000 });
      out.push({ name: file, mimeType, buffer: readFileSync(join(dir, file)) });
    } catch {
      /* no ffmpeg (or no encoder): the WAV path is still tested */
    }
  }
  return out;
}

test("03-songs: upload, ownership, play, remove", async ({ party, server, browser, baseURL }) => {
  await party.hostFromLanding();
  await party.addGuests(3);
  await party.waitAllReady();
  const host = party.host.page;
  const drawerError = () => host.getByRole("alert").filter({ hasNotText: /^$/ });

  // --- upload a WAV through the drawer -------------------------------------------------------
  await host.getByRole("button", { name: "Songs", exact: true }).click();
  const wav = makeWav(20, { toneHz: 523 });
  const uploadLabels: string[] = [];
  const poll = setInterval(() => {
    host
      .locator("button.border-dashed")
      .innerText({ timeout: 500 })
      .then((t) => {
        if (uploadLabels.at(-1) !== t) uploadLabels.push(t);
      })
      .catch(() => {});
  }, 60);
  const t0 = performance.now();
  await host.locator('input[type="file"]').setInputFiles({ name: "Party Upload WAV.wav", mimeType: "audio/wav", buffer: wav });
  const row = host.getByRole("button").filter({ hasText: "Party Upload WAV" });
  let uploadError: string | null = null;
  for (let i = 0; i < 300; i++) {
    if (await row.count()) break;
    if (await drawerError().count()) {
      uploadError = (await drawerError().first().innerText()).trim();
      break;
    }
    await sleep(100);
  }
  clearInterval(poll);
  party.metrics.upload = { ms: Math.round(performance.now() - t0), labels: uploadLabels, error: uploadError };
  await party.host.screenshot("03-songs-after-upload-host.png");
  if (uploadError) party.note(`upload refused: "${uploadError}"`);
  expect(uploadError, "uploading a WAV from the Songs drawer is refused").toBeNull();
  expect(await row.count(), "the uploaded song appears in the drawer").toBe(1);
  const removeBtn = host.getByRole("button", { name: /^Remove Party Upload WAV/ });
  expect.soft(await removeBtn.count(), "the uploader's own song carries a remove control").toBe(1);
  expect.soft(await host.getByRole("button", { name: /^Remove Synthetic/ }).count(), "shared songs carry no remove control").toBe(0);

  const serverList = (await (await fetch(`${API}/tracks`)).json()) as { tracks: Array<{ id: string; title: string; bpm?: number; durationSec: number; stems: string[] }> };
  party.metrics.anonymousTrackList = serverList.tracks.map((t) => t.title);
  expect.soft(serverList.tracks.some((t) => /Party Upload/.test(t.title)), "GET /tracks without a host key does not list an owned upload").toBe(false);

  // --- MP3 / M4A, decoded in the browser ------------------------------------------------------
  const variants = ffmpegVariants(wav);
  const variantResults: Array<{ name: string; ok: boolean; error: string | null; ms: number }> = [];
  for (const v of variants) {
    const started = performance.now();
    await host.locator('input[type="file"]').setInputFiles(v);
    const title = v.name.replace(/\.\w+$/, "");
    const vRow = host.getByRole("button").filter({ hasText: title });
    let err: string | null = null;
    let ok = false;
    for (let i = 0; i < 300 && !ok && !err; i++) {
      ok = (await vRow.count()) > 0;
      if (!ok && (await drawerError().count())) err = (await drawerError().first().innerText()).trim();
      if (!ok && !err) await sleep(100);
    }
    variantResults.push({ name: v.name, ok, error: err, ms: Math.round(performance.now() - started) });
    expect.soft(ok, `${v.name} uploads (${err ?? "timed out"})`).toBe(true);
  }
  party.metrics.compressedUploads = variants.length ? variantResults : "ffmpeg not available — only WAV tested";

  // --- a second host, in another browser profile, never sees it -------------------------------
  const other = new Party(browser, baseURL!, "03-songs-second-host");
  await other.hostFromLanding();
  await other.host.page.getByRole("button", { name: "Songs", exact: true }).click();
  await sleep(1500);
  const otherSees = await other.host.page.getByRole("button").filter({ hasText: /Party Upload/ }).count();
  party.metrics.secondHostSeesUpload = otherSees;
  await other.host.screenshot("03-songs-second-host.png");
  expect.soft(otherSees, "a second host with its own storage sees the first host's upload").toBe(0);
  party.metrics.secondHostIssues = other.issues();
  await other.close();

  // --- select it → "Up next" + Start → plays on every guest -----------------------------------
  await row.click();
  await expect.soft(host.getByText("Up next:")).toContainText("Party Upload WAV", { timeout: 10_000 });
  const uploadedId = party.host.room?.track?.id ?? null;
  party.metrics.uploadedTrack = { id: uploadedId, bpm: party.host.room?.track?.bpm ?? null, durationSec: party.host.room?.track?.durationSec ?? null, stems: party.host.room?.track?.stems ?? null };
  await party.waitAllReady();
  const tts = await party.startMusic();
  party.metrics.timeToSoundFromTapMs = tts;
  for (const [name, ms] of Object.entries(tts)) expect.soft(ms, `${name} never played the uploaded song`).not.toBeNull();
  await sleep(2500);
  const playing = await party.sampleAll(party.guests);
  party.metrics.spreadOnUpload = party.spread(playing);
  expect
    .soft(
      playing.filter((s) => s.rms <= SOUND_RMS || s.trackId !== uploadedId).map((s) => s.name),
      "every guest is sounding on the uploaded song",
    )
    .toEqual([]);

  // --- remove: refused while it is playing ----------------------------------------------------
  await host.getByRole("button", { name: "Songs", exact: true }).click();
  await removeBtn.click();
  await host.getByRole("button", { name: /Remove Party Upload WAV\? Tap again/ }).click();
  await sleep(1500);
  const refusal = (await drawerError().count()) ? (await drawerError().first().innerText()).trim() : null;
  party.metrics.removeWhilePlaying = { message: refusal, stillListed: await row.count() };
  await party.host.screenshot("03-songs-remove-refused-host.png");
  expect.soft(await row.count(), "a song that is playing is not removed").toBe(1);
  expect.soft(refusal, "the host is told why the song was not removed").toBeTruthy();
  const stillPlaying = await party.sampleAll(party.guests);
  expect.soft(stillPlaying.filter((s) => s.rms <= SOUND_RMS).map((s) => s.name), "the refused removal did not interrupt the music").toEqual([]);

  // --- switch songs, then remove: allowed -----------------------------------------------------
  await host.getByRole("button").filter({ hasText: "Synthetic 60" }).first().click();
  await host.getByText("Up next:").waitFor({ timeout: 10_000 });
  await host.getByRole("button", { name: "Songs", exact: true }).click();
  await removeBtn.click();
  await host.getByRole("button", { name: /Remove Party Upload WAV\? Tap again/ }).click();
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = (await row.count()) === 0;
    if (!gone) await sleep(100);
  }
  const afterRemoveError = (await drawerError().count()) ? (await drawerError().first().innerText()).trim() : null;
  party.metrics.removeAfterSwitch = { gone, message: afterRemoveError };
  expect.soft(gone, `the song is removed once it is no longer the room's song (${afterRemoveError ?? "no message"})`).toBe(true);
  await party.screenshots("end");
  party.metrics.health = await server.current.health();
  party.metrics.serverLogTail = server.current.log().split("\n").slice(-15);
  // The 409 for "remove while playing" is the refusal under test, not a second finding.
  const unexpected = party.unexpectedIssues(/409 DELETE|status of 409/);
  party.metrics.issuesAll = party.issues();
  expect.soft(unexpected, "console errors / page errors / failed requests in any context").toEqual([]);
});
