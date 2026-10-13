import { test, expect } from "./test";
import { Device, SOUND_RMS, line, round, sleep } from "./harness";

/**
 * Scenario 6 — the host behaving like a host: reloading mid-song, using its own phone as a speaker,
 * a second browser opening the host URL without the key, pause / seek / another song, and Exit.
 */
test("06-host: reload, speaker toggle, keyless /h, pause-seek-skip, exit", async ({ party }) => {
  await party.begin(3, { song: "Synthetic 60" });
  await sleep(3000);
  const host = party.host;
  const m: Record<string, unknown> = {};
  party.metrics.host = m; // by reference: whatever was measured survives a later step throwing
  const code = party.code;

  // a. Reload the host page mid-song.
  {
    const from = await party.guests[0]!.pageWall();
    const zero = host.room!.transport.state === "playing" ? host.room!.transport.serverTimeAtTrackZero : null;
    const idBefore = host.clientId;
    const t0 = performance.now();
    await host.page.reload();
    let stageMs: number | null = null;
    while (performance.now() - t0 < 20_000 && stageMs === null) {
      const s = await host.sample();
      if (s.screen === "host:stage-playing" && host.welcome && s.wsOpen) stageMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    await sleep(2500);
    const to = await party.guests[0]!.pageWall();
    const dead = await party.deadAir(party.guests, from, to, 50);
    const perGuestGaps: Record<string, number> = {};
    for (const g of party.guests) perGuestGaps[g.name] = (await party.deadAir([g], from, to, 50)).longestMs;
    const s = await host.sample();
    m.hostReload = {
      stageBackMs: stageMs,
      screen: s.screen,
      isHost: host.welcome?.isHost ?? null,
      sameClientId: host.clientId === idBefore,
      sameTimeline: host.room?.transport.state === "playing" && host.room.transport.serverTimeAtTrackZero === zero,
      guestLongestSilenceMs: perGuestGaps,
      roomDeadAirMs: dead.longestMs,
      players: s.text.match(/\d+ players/)?.[0] ?? null,
    };
    expect.soft(stageMs, "the reloaded host lands back on the playing stage").not.toBeNull();
    expect.soft(host.welcome?.isHost, "the reloaded host is still the host").toBe(true);
    expect.soft(Math.max(...Object.values(perGuestGaps)), "guests' music is uninterrupted by a host reload (longest silence, ms)").toBeLessThan(200);
    expect.soft(host.room?.transport.state, "the room is still playing after the host reload").toBe("playing");
  }

  // b. "This phone plays music too" on and off.
  {
    const box = host.page.getByRole("checkbox", { name: "This phone plays music too" });
    await box.check();
    const t0 = performance.now();
    let soundMs: number | null = null;
    while (performance.now() - t0 < 15_000 && soundMs === null) {
      if ((await host.sample()).rms > SOUND_RMS) soundMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    await sleep(3000);
    const all = await party.sampleAll();
    const hs = all[0]!;
    const others = all.slice(1).map((s) => s.residualMs).filter((x): x is number => x !== null);
    const mean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : null;
    party.note("host as speaker:\n" + all.map(line).join("\n"));
    await box.uncheck();
    await sleep(1500);
    const off = await host.sample();
    m.hostSpeaker = { soundMs, hostResidualMs: round(hs.residualMs), offsetFromGuestsMs: hs.residualMs !== null && mean !== null ? round(hs.residualMs - mean) : null, hostLabel: hs.label, rmsAfterOff: round(off.rms, 4), mapLabel: await host.page.locator('svg[aria-label^="Hive map"]').getAttribute("aria-label") };
    expect.soft(soundMs, "the host phone makes sound when its speaker toggle is on").not.toBeNull();
    if (hs.residualMs !== null && mean !== null) expect.soft(Math.abs(hs.residualMs - mean), "host speaker vs guests (ms)").toBeLessThan(15);
    expect.soft(off.rms, "the host phone is silent when its speaker toggle is off").toBeLessThan(SOUND_RMS);
  }

  // c. /h/CODE in a second browser with no key.
  {
    const intruder: Device = await party.newDevice("keyless", "host");
    const errorsBefore = host.serverErrors.length;
    await intruder.page.goto(`/h/${code}`);
    await sleep(4000);
    const s = await intruder.sample();
    await intruder.screenshot("06-host-keyless.png");
    const links = await intruder.page.getByRole("link").allInnerTexts();
    const guests = await party.sampleAll(party.guests);
    m.keyless = { screen: s.screen, text: s.text.slice(0, 160), links, hostStillHost: host.room?.hostClientIds.includes(host.clientId ?? "") ?? null, hostErrors: host.serverErrors.slice(errorsBefore), guestsSounding: guests.filter((g) => g.sounding).length, intruderIssues: intruder.issues.map((i) => `${i.kind}: ${i.text}`) };
    expect.soft(s.screen, "a keyless /h/CODE is refused").toBe("host:elsewhere");
    expect.soft(links.some((l) => /Join as a guest/.test(l)), "the refusal offers a way forward").toBe(true);
    expect.soft(guests.filter((g) => !g.sounding).map((g) => g.name), "the keyless visit did not disturb the party").toEqual([]);
    expect.soft(host.serverErrors.length, "the real host got no error from the keyless visit").toBe(errorsBefore);
    await intruder.close();
  }

  // d. Pause, play, seek, another song.
  {
    await host.page.getByRole("button", { name: "Pause", exact: true }).click();
    await sleep(1500);
    const paused = await party.sampleAll(party.guests);
    const pausedText = paused[0]!.text.slice(0, 200);
    await party.guests[0]!.screenshot("06-host-guest-paused.png");
    await host.page.getByRole("button", { name: "Play", exact: true }).click();
    await sleep(2500);
    const resumed = await party.sampleAll(party.guests);
    m.pause = { silentWhilePaused: paused.filter((s) => s.rms <= SOUND_RMS).length, guestScreens: paused.map((s) => s.screen), guestText: pausedText, soundingAfterPlay: resumed.filter((s) => s.sounding).length, spreadAfterPlay: party.spread(resumed).residualSpreadMs, positions: resumed.map((s) => round(s.posSec, 2)) };
    expect.soft(paused.filter((s) => s.rms > SOUND_RMS).map((s) => s.name), "paused: every guest silent").toEqual([]);
    expect.soft(resumed.filter((s) => !s.sounding).map((s) => s.name), "play after pause: every guest sounding").toEqual([]);

    const slider = host.page.getByRole("slider", { name: "Seek" });
    const box = (await slider.boundingBox())!;
    await host.page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await sleep(2500);
    const seeked = await party.sampleAll(party.guests);
    m.seek = { positions: seeked.map((s) => round(s.posSec, 2)), expected: round(seeked[0]!.expectedSec, 2), sounding: seeked.filter((s) => s.sounding).length, spread: party.spread(seeked).residualSpreadMs };
    expect.soft(seeked.filter((s) => !s.sounding).map((s) => s.name), "after a seek every guest sounds").toEqual([]);
    const sp = party.spread(seeked).residualSpreadMs;
    if (sp !== null) expect.soft(sp, "after a seek: sync spread (ms)").toBeLessThan(15);
    for (const s of seeked) if (s.posSec !== null) expect.soft(s.posSec, `${s.name} jumped to the seek position`).toBeGreaterThan(30);

    // Another song mid-song: the stage offers Start for it; one tap and it plays.
    await party.pickSong("Synthetic 30");
    await sleep(1200);
    const stopped = await party.sampleAll(party.guests);
    await party.waitAllReady();
    const tts = await party.startMusic();
    await sleep(2000);
    const onNew = await party.sampleAll(party.guests);
    m.skip = { guestScreensWhenStopped: stopped.map((s) => s.screen), silentWhenStopped: stopped.filter((s) => s.rms <= SOUND_RMS).length, timeToSoundMs: tts, track: onNew.map((s) => s.trackId), spread: party.spread(onNew).residualSpreadMs };
    expect.soft(stopped.filter((s) => s.rms > SOUND_RMS).map((s) => s.name), "picking another song stops the old one on every guest").toEqual([]);
    expect.soft(onNew.filter((s) => !s.sounding || s.trackId !== "synthetic-30s-lite").map((s) => s.name), "every guest plays the newly picked song").toEqual([]);
  }
  await party.screenshots("mid");

  // e. Exit: guests are paused and told.
  {
    await host.page.getByRole("button", { name: "Exit the hive" }).click();
    await host.page.waitForURL((u) => u.pathname === "/", { timeout: 10_000 }).catch(() => {});
    await sleep(3000);
    const guests = await party.sampleAll(party.guests);
    await party.guests[0]!.screenshot("06-host-guest-after-exit.png");
    m.exit = { hostUrl: host.page.url(), guestScreens: guests.map((s) => s.screen), guestSounding: guests.filter((s) => s.rms > SOUND_RMS).length, guestText: guests[0]!.text.slice(0, 240), transport: guests[0]!.transport };
    expect.soft(guests.filter((s) => s.rms > SOUND_RMS).map((s) => s.name), "after the host exits no guest keeps playing").toEqual([]);
    expect.soft(/host/i.test(guests[0]!.text), `guests are told the host left ("${guests[0]!.text.slice(0, 120)}")`).toBe(true);
    // The player page has a line for exactly this ("Waiting for the host to come back"); the host's
    // socket is gone by now, so it should be showing.
    const hostIds = party.guests[0]!.room?.hostClientIds ?? [];
    (m.exit as Record<string, unknown>).guestSnapshotHostClientIds = hostIds.length;
    (m.exit as Record<string, unknown>).saysHostAway = guests.map((s) => /Waiting for the host to come back/.test(s.text));
    expect.soft(guests.filter((s) => !/Waiting for the host to come back/.test(s.text)).map((s) => s.name), 'guests whose screen does not say "Waiting for the host to come back" 3 s after the host left').toEqual([]);
  }

  party.metrics.host = m;
  party.note(JSON.stringify(m));
  party.metrics.issuesAll = party.issues();
  expect.soft(party.unexpectedIssues(), "console errors / page errors / failed requests in any context").toEqual([]);
});
