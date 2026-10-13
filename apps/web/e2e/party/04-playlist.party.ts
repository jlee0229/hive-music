import { test, expect } from "./test";
import { SOUND_RMS, round, sleep } from "./harness";

/**
 * Scenario 4 — the playlist. Three short one-stem songs and nothing else in the library: the room
 * must advance on its own. Per advance and per guest this measures
 *  - readiness: when the phone told the server it had the next song (AUDIO_READY), relative to the
 *    instant that song was scheduled to start (negative = ready in time);
 *  - the gap: how long the phone was silent around the boundary;
 *  - lateness: when its first sound of the new song came, relative to the scheduled start;
 *  - whether it ever ended up on the wrong audio (still the old song after the new one started).
 */
test.use({
  library: {
    synthetic: false,
    seed: [
      { id: "party-a", title: "Party A", seconds: 14, toneHz: 330 },
      { id: "party-b", title: "Party B", seconds: 12, toneHz: 440 },
      { id: "party-c", title: "Party C", seconds: 16, toneHz: 550 },
    ],
  },
});

test("04-playlist: three short songs advance on their own", async ({ party }) => {
  const GUESTS = 4;
  await party.begin(GUESTS);
  const first = party.host.room!.track!.id;
  party.note(`first song ${first}, nextTrack hint: ${JSON.stringify((party.host.room as unknown as { nextTrack?: { id: string } }).nextTrack?.id ?? null)}`);

  // Follow the room for ~60 s; note every change of track as the host's socket sees it.
  type Advance = { to: string; from: string; announcedWall: number; startServerTime: number; leadMs: number };
  const advances: Advance[] = [];
  let current = first;
  const t0 = performance.now();
  const fromWall = await party.host.pageWall();
  const offset = (await party.host.serverOffsetMs()) ?? 0;
  const liveLog: Array<{ atSec: number; perGuest: Array<{ name: string; buf: number | null; sounding: boolean; pos: number | null; track: string | null; residual: number | null }> }> = [];
  while (performance.now() - t0 < 62_000) {
    const room = party.host.room!;
    if (room.track && room.track.id !== current && room.transport.state === "playing") {
      const wall = await party.host.pageWall();
      advances.push({ from: current, to: room.track.id, announcedWall: wall, startServerTime: room.transport.serverTimeAtTrackZero, leadMs: Math.round(room.transport.serverTimeAtTrackZero - (wall + offset)) });
      current = room.track.id;
    }
    const samples = await party.sampleAll(party.guests);
    liveLog.push({ atSec: round((performance.now() - t0) / 1000)!, perGuest: samples.map((s) => ({ name: s.name, buf: s.bufferId, sounding: s.rms > SOUND_RMS, pos: s.posSec, track: s.trackId, residual: s.residualMs })) });
    await sleep(200);
  }
  const toWall = await party.host.pageWall();
  expect.soft(advances.length, "the room advanced to the next song on its own at least three times in 62 s").toBeGreaterThanOrEqual(3);
  expect.soft(new Set(advances.map((a) => a.to)).size, "the rotation visits every song").toBe(3);

  // Per advance, per guest.
  const perAdvance: Array<Record<string, unknown>> = [];
  for (const adv of advances) {
    const startWallHost = adv.startServerTime - offset; // every page shares this machine's clock
    const rows: Array<{ name: string; fetchedMs: number | null; readyMs: number | null; firstSoundMs: number | null; gapMs: number; wrongAudio: boolean }> = [];
    for (const g of party.guests) {
      const ready = g.sent.find((m) => m.type === "AUDIO_READY" && m.detail === adv.to && m.at > adv.announcedWall - 60_000);
      // Node's clock and the page's are the same wall clock; `sent.at` is node-side.
      const readyMs = ready ? Math.round(ready.at - startWallHost) : null;
      // Prefetch: when the next song's last stem finished downloading on this phone, relative to its start.
      const fetches = g.audioFetches.filter((f) => f.track === adv.to && f.at > adv.announcedWall - 120_000 && f.at < startWallHost + 10_000);
      const fetchedMs = fetches.length && fetches.every((f) => f.doneAt !== null) ? Math.round(Math.max(...fetches.map((f) => f.doneAt!)) - startWallHost) : null;
      const ring = await g.ringSince(startWallHost - 8000);
      const around = ring.filter(([t]) => t <= startWallHost + 6000);
      const firstLoud = around.find(([t, rms]) => t >= startWallHost - 30 && rms > SOUND_RMS);
      // Longest silent stretch in the window around the boundary.
      let gap = 0;
      let runStart: number | null = null;
      for (const [t, rms] of around) {
        if (rms <= SOUND_RMS) runStart ??= t;
        else if (runStart !== null) {
          gap = Math.max(gap, t - runStart);
          runStart = null;
        }
      }
      if (runStart !== null && around.length) gap = Math.max(gap, around.at(-1)![0] - runStart);
      // Wrong audio: one second into the new song the phone is still on the buffer it played before the advance.
      const startSec = (startWallHost - fromWall) / 1000;
      const beforeBuf = liveLog.filter((l) => l.atSec < startSec - 6).at(-1)?.perGuest.find((p) => p.name === g.name)?.buf ?? null;
      const afterRow = liveLog.find((l) => l.atSec > startSec + 1.5)?.perGuest.find((p) => p.name === g.name);
      rows.push({
        name: g.name,
        fetchedMs,
        readyMs,
        firstSoundMs: firstLoud ? Math.round(firstLoud[0] - startWallHost) : null,
        gapMs: Math.round(gap),
        wrongAudio: !!afterRow && afterRow.buf !== null && afterRow.buf === beforeBuf,
      });
    }
    // Sync spread across the guests in the first seconds of the new song.
    const startSec = (startWallHost - fromWall) / 1000;
    const spreadAt = (afterSec: number) => {
      const res = liveLog.find((l) => l.atSec >= startSec + afterSec)?.perGuest.map((p) => p.residual).filter((x): x is number => x !== null) ?? [];
      return res.length === party.guests.length ? round(Math.max(...res) - Math.min(...res)) : null;
    };
    const spreadAfterStartMs = { "0.5s": spreadAt(0.5), "2s": spreadAt(2), "5s": spreadAt(5), "9s": spreadAt(9) };
    perAdvance.push({ from: adv.from, to: adv.to, announcedLeadMs: adv.leadMs, spreadAfterStartMs, guests: rows });
    if (spreadAfterStartMs["2s"] !== null) expect.soft(spreadAfterStartMs["2s"], `${adv.from}→${adv.to}: sync spread 2 s into the new song (ms)`).toBeLessThan(10);
    for (const r of rows) {
      if (startWallHost + 6000 > toWall) continue; // the watch ended before this advance played out
      expect.soft(r.firstSoundMs, `${adv.from}→${adv.to}: ${r.name} never sounded on the new song`).not.toBeNull();
      expect.soft(r.readyMs, `${adv.from}→${adv.to}: ${r.name} never reported the new song ready`).not.toBeNull();
      if (r.readyMs !== null) expect.soft(r.readyMs, `${adv.from}→${adv.to}: ${r.name} had the next song ready before its start (ms relative to start)`).toBeLessThan(0);
      if (r.firstSoundMs !== null) expect.soft(r.firstSoundMs, `${adv.from}→${adv.to}: ${r.name} first sound vs the scheduled start (ms)`).toBeLessThan(400);
      expect.soft(r.wrongAudio, `${adv.from}→${adv.to}: ${r.name} stayed on the old song`).toBe(false);
    }
  }
  party.metrics.advances = perAdvance;
  const gaps = perAdvance.flatMap((a) => (a.guests as Array<{ gapMs: number }>).map((g) => g.gapMs));
  party.metrics.gapBetweenSongsMs = gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), median: gaps.slice().sort((a, b) => a - b)[gaps.length >> 1] } : null;
  party.note(`advances: ${JSON.stringify(perAdvance)}`);
  // The server leaves TRACK_ADVANCE_LEAD_MS (2 s) between songs; measured 1.95-2.0 s. It was 5 s, which
  // a room hears as "it stopped". Tighten this when the advance becomes gapless.
  if (gaps.length) expect.soft(Math.max(...gaps), "longest silence a guest heard around a song change (ms)").toBeLessThan(2500);

  const end = await party.sampleAll(party.guests);
  expect
    .soft(
      end.filter((s) => s.screen !== "guest:playing").map((s) => `${s.name}:${s.screen}`),
      "every guest still on the playing screen",
    )
    .toEqual([]);
  await party.screenshots("end");
  expect.soft(party.unexpectedIssues(), "console errors / page errors / failed requests in any context").toEqual([]);
});
