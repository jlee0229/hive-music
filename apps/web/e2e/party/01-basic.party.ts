import { test, expect } from "./test";
import { line, round, sleep, type DeviceSample } from "./harness";

/**
 * Scenario 1 — the party everyone will actually have: a host arrives from the landing page, five
 * guests join by link, the host presses Start once. The tuning moment runs against Chromium's fake
 * microphone (a beep, not the phones' clicks): it must not make anything worse.
 */
test("01-basic: landing → host → five guests → Start → 60 s of music", async ({ party, server }) => {
  const code = await party.hostFromLanding();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);

  await party.addGuests(5, "Guest", { iosEvery: 3 });
  party.metrics.readyMs = Math.round(await party.waitAllReady());
  const before = await party.sampleAll();
  party.note("before start:\n" + before.map(line).join("\n"));
  expect
    .soft(
      before.filter((s) => s.name !== "host").map((s) => s.screen),
      "every guest is on the ready screen before Start",
    )
    .toEqual(Array(5).fill("guest:ready"));
  expect
    .soft(
      before.filter((s) => s.sounding).map((s) => s.name),
      "nobody makes sound before Start",
    )
    .toEqual([]);
  await party.screenshots("before-start");

  // Start: one tap. Record what the host's screen and the room's calibration do until music.
  const startedAt = performance.now();
  await party.pressStart();
  const timeline: Array<{ atMs: number; host: string; calibration: string; transport: string }> = [];
  const push = async () => {
    const s = await party.host.sample();
    const row = { atMs: Math.round(performance.now() - startedAt), host: s.screen, calibration: party.host.room?.calibration.state ?? "?", transport: s.transport ?? "?" };
    const last = timeline.at(-1);
    if (!last || last.host !== row.host || last.calibration !== row.calibration || last.transport !== row.transport) timeline.push(row);
  };
  let guestTuningSeen = 0;
  while (performance.now() - startedAt < 40_000 && party.host.room?.transport.state !== "playing") {
    await push();
    const gs = await party.sampleAll(party.guests);
    guestTuningSeen = Math.max(guestTuningSeen, gs.filter((g) => g.screen === "guest:tuning").length);
    await sleep(150);
  }
  await push();
  const playSent = party.host.sent.find((m) => m.type === "TRANSPORT" && m.detail === "PLAY");
  party.metrics.startTimeline = timeline;
  party.metrics.guestsOnTuningScreen = guestTuningSeen;
  party.metrics.tapToPlayingMs = timeline.at(-1)?.atMs ?? null;
  expect(party.host.room?.transport.state, "the room starts playing after one tap on Start").toBe("playing");
  expect.soft(playSent, "the host sent TRANSPORT PLAY").toBeTruthy();

  // What the tuning moment did to the phones' offsets.
  await sleep(500);
  const cal = party.host.room!.calibration;
  const offsets = Object.values(party.host.room!.clients)
    .filter((c) => c.kind === "player")
    .map((c) => ({ name: c.name, family: c.device.browserFamily, table: c.tableLatencyMs, calibrated: c.calibratedOffsetMs, comp: c.assignment?.compensationMs ?? null }));
  party.metrics.calibration = { state: cal.state, results: cal.results, offsets };
  party.note(`calibration ${cal.state}: ${JSON.stringify(offsets)}`);
  for (const o of offsets) {
    expect.soft(Math.abs(o.calibrated ?? 0), `${o.name}: a fake microphone must not earn a large measured offset`).toBeLessThan(80);
  }

  // Time to sound, from the tap.
  const tts = await party.timeToSound(party.guests, startedAt, 60_000);
  party.metrics.timeToSoundFromTapMs = tts;
  const playingAt = timeline.at(-1)!.atMs;
  party.metrics.timeToSoundAfterPlayingMs = Object.fromEntries(Object.entries(tts).map(([k, v]) => [k, v === null ? null : v - playingAt]));
  for (const [name, ms] of Object.entries(tts)) expect.soft(ms, `${name} never made a sound`).not.toBeNull();

  // 60 s: every phone sounding, spread small and stable. The first song in the list is 30 s long, so
  // this crosses one playlist advance; the gap between songs is scenario 4's subject, not this one's.
  const betweenSongs = (t: { samples: DeviceSample[] }) => t.samples.every((s) => s.expectedSec !== null && s.expectedSec < 0.3);
  await sleep(3000); // let the first drift checks settle
  const ticks = await party.watch(60_000, 2000);
  const spreads = ticks.map((t) => t.spread.residualSpreadMs).filter((x): x is number => x !== null);
  const worst = Math.max(...spreads);
  const perDevice: Record<string, { min: number; max: number; mean: number }> = {};
  for (const g of party.guests) {
    const xs = ticks.map((t) => t.samples.find((s) => s.name === g.name)?.residualMs).filter((x): x is number => x != null);
    if (xs.length) perDevice[g.name] = { min: round(Math.min(...xs))!, max: round(Math.max(...xs))!, mean: round(xs.reduce((a, b) => a + b, 0) / xs.length)! };
  }
  party.metrics.sync60s = {
    ticks: ticks.length,
    residualSpreadMs: { first: spreads[0] ?? null, median: spreads.slice().sort((a, b) => a - b)[spreads.length >> 1] ?? null, worst, last: spreads.at(-1) ?? null },
    perDeviceResidualMs: perDevice,
    silentTicks: ticks.filter((t) => t.silent.length).map((t) => ({ atSec: t.atSec, silent: t.silent, betweenSongs: betweenSongs(t) })),
    series: ticks.map((t) => ({ atSec: t.atSec, spread: t.spread.residualSpreadMs, sounding: t.spread.sounding, track: t.samples[0]?.trackId })),
  };
  party.note("after 60 s:\n" + ticks.at(-1)!.samples.map(line).join("\n"));
  expect
    .soft(
      ticks.filter((t) => t.silent.length && !betweenSongs(t)).map((t) => `${t.atSec}s: ${t.silent.join(",")}`),
      "a phone was silent during the 60 s",
    )
    .toEqual([]);
  expect.soft(worst, "sync spread across the five phones (ms)").toBeLessThan(15);

  const after: DeviceSample[] = await party.sampleAll(party.guests);
  expect
    .soft(
      after.map((s) => s.screen),
      "guest screens show the playing screen",
    )
    .toEqual(Array(5).fill("guest:playing"));
  for (const s of after) expect.soft(s.label, `${s.name} shows a role`).toBeTruthy();
  for (const s of after) expect.soft(s.seen["Tap to resume"] ?? 0, `${s.name} saw "Tap to resume" during an ordinary party`).toBe(0);

  // The host map: five named dots, none overlapping.
  const dots = await party.host.page.locator('svg[aria-label^="Hive map"] g[data-client-id]').evaluateAll((gs) =>
    gs.map((g) => {
      const c = g.querySelector("circle")!.getBoundingClientRect();
      // The <text> holds a <title> (the full name) and the fitted label as a text node.
      const label = [...(g.querySelector("text")?.childNodes ?? [])]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("");
      return { id: g.getAttribute("data-client-id"), label, x: c.x + c.width / 2, y: c.y + c.height / 2, r: c.width / 2 };
    }),
  );
  party.metrics.mapDots = dots;
  expect.soft(dots.length, "five dots on the host map").toBe(5);
  for (let i = 0; i < dots.length; i++)
    for (let j = i + 1; j < dots.length; j++) {
      const d = Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y);
      expect.soft(d, `dots ${dots[i]!.label} and ${dots[j]!.label} overlap`).toBeGreaterThan(dots[i]!.r + dots[j]!.r);
    }
  expect
    .soft(
      dots.map((d) => d.label).sort(),
      "dots carry the guests' names",
    )
    .toEqual(["Guest 1", "Guest 2", "Guest 3", "Guest 4", "Guest 5"]);
  expect.soft(await party.host.page.getByText("5 players").count(), "the host header counts five players").toBe(1);

  party.metrics.health = await server.current.health();
  await party.screenshots("end");
  const issues = party.unexpectedIssues();
  expect.soft(issues, "console errors / page errors / failed requests in any context").toEqual([]);
});
