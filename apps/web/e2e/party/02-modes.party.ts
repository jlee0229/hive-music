import { test, expect } from "./test";
import { Party, SOUND_RMS, line, round, sleep, type Device } from "./harness";

/**
 * Scenario 2 — every mode, on the real engine. Assertions are about what a room would hear:
 * UNISON/STEREO/WAVE/CHOIR every phone sounding; ORCHESTRA every stem audible on some sounding
 * phone; STROBE no dead air (at every moment at least one phone sounding).
 */

type Stem = string;
const AUDIBLE_DB = -40;

/** stem → the connected speakers that carry it audibly, as the host's snapshot has it. */
function stemCarriers(party: Party): Record<Stem, string[]> {
  const room = party.host.room!;
  const out: Record<Stem, string[]> = {};
  for (const stem of room.track?.stems ?? []) {
    out[stem] = Object.values(room.clients)
      .filter((c) => c.plays && c.connected && c.assignment && (c.assignment.gainsDb[stem] ?? 0) > AUDIBLE_DB)
      .map((c) => c.name);
  }
  return out;
}

/** Dead air over the last `ms` across `devices`, with the page clock of the first as the frame. */
async function deadAirOver(party: Party, devices: Device[], ms: number) {
  const to = await devices[0]!.pageWall();
  return party.deadAir(devices, to - ms, to, 50);
}

async function checkIssues(party: Party) {
  party.metrics.issuesAll = party.issues();
  expect.soft(party.unexpectedIssues(), "console errors / page errors / failed requests in any context").toEqual([]);
}

for (const variant of [
  // One song in the library each: it loops seamlessly, so no playlist gap lands inside a mode's window
  // (the gap between songs is scenario 4's subject).
  { id: "02a-modes-4stem", song: "Synthetic 60", library: { synthetic: ["synthetic-60s"] } },
  { id: "02e-modes-1stem", song: "One Stem", library: { synthetic: false, seed: [{ id: "one-stem", title: "One Stem", seconds: 75, toneHz: 440 }] } },
]) {
  test.describe(variant.id, () => {
    test.use({ library: variant.library });
    test(`${variant.id}: every mode for 20 s on "${variant.song}"`, async ({ party }) => {
      await party.begin(5, { song: variant.song });
      await sleep(3000);
      const results: Record<string, unknown> = {};
      for (const mode of ["Unison", "Orchestra", "Stereo", "Wave", "Strobe", "Choir"] as const) {
        const startCallsBefore = (await party.sampleAll(party.guests)).map((s) => s.startCalls);
        await party.setMode(mode);
        const switchedAt = performance.now();
        await sleep(1500);
        const ticks = await party.watch(mode === "Choir" ? 30_000 : 18_000, 1500);
        const lastSamples = ticks.at(-1)!.samples;
        const spreads = ticks.map((t) => t.spread.residualSpreadMs).filter((x): x is number => x !== null);
        const dead = await deadAirOver(party, party.guests, 15_000);
        const carriers = stemCarriers(party);
        const r = {
          labels: lastSamples.map((s) => `${s.name}:${s.label}`),
          soundingAtEnd: lastSamples.filter((s) => s.sounding).length,
          silentTicks: ticks.filter((t) => t.silent.length).map((t) => `${t.atSec}s:${t.silent.join(",")}`),
          residualSpreadMs: { median: spreads.slice().sort((a, b) => a - b)[spreads.length >> 1] ?? null, worst: spreads.length ? Math.max(...spreads) : null },
          deadAir: { coveredPct: dead.coveredPct, longestMs: dead.longestMs, gaps: dead.gaps.length, perDeviceSoundingPct: dead.perDeviceSoundingPct },
          stemCarriers: carriers,
          delaysMs: party.guests.map((g) => g.me?.assignment?.delayMs ?? null),
          pitches: party.guests.map((g) => g.me?.assignment?.pitchSemitones ?? 0),
          peakHz: lastSamples.map((s) => s.peakHz),
          restartsDuringMode: lastSamples.map((s, i) => s.startCalls - startCallsBefore[i]!),
          worstStallMs: Math.max(...lastSamples.map((s) => s.stallMs ?? 0)),
          settleMs: Math.round(performance.now() - switchedAt),
        };
        results[mode] = r;
        party.note(`${mode}:\n` + lastSamples.map(line).join("\n"));
        await party.screenshots(mode.toLowerCase());

        if (mode !== "Strobe") expect.soft(r.silentTicks, `${mode}: a phone was silent`).toEqual([]);
        expect.soft(dead.longestMs, `${mode}: longest stretch with no phone sounding (ms)`).toBeLessThan(200);
        if (r.residualSpreadMs.worst !== null) expect.soft(r.residualSpreadMs.worst, `${mode}: sync spread net of intended delays (ms)`).toBeLessThan(15);
        for (const [stem, who] of Object.entries(carriers)) expect.soft(who.length, `${mode}: stem "${stem}" is audible on at least one phone`).toBeGreaterThan(0);
        if (mode === "Wave") expect.soft(new Set(r.delaysMs).size, "WAVE: untouched auto-placed phones get different delays").toBe(5);
        if (mode === "Choir") expect.soft(new Set(r.pitches).size, "CHOIR: phones are given different pitches").toBeGreaterThan(1);
        // The one-stem song is a 440 Hz tone: a phone given +12 must be emitting ~880 Hz, −12 ~220, +7 ~659.
        if (mode === "Choir" && variant.id === "02e-modes-1stem") {
          r.pitches.forEach((p, i) => {
            const want = 440 * 2 ** (p / 12);
            expect.soft(Math.abs((r.peakHz[i] ?? 0) - want), `CHOIR: ${party.guests[i]!.name} (pitch ${p}) emits ~${Math.round(want)} Hz (measured ${r.peakHz[i]})`).toBeLessThan(40);
          });
        }
      }
      party.metrics.modes = results;
      await checkIssues(party);
    });
  });
}

test("02b-orchestra: 1, 2, 3, 5 guests — every stem audible somewhere, and a leaver's stem is handed on", async ({ party }) => {
  await party.hostFromLanding();
  await party.pickSongIfNeeded("Synthetic 60");
  const steps: Array<Record<string, unknown>> = [];
  await party.addGuests(1);
  await party.waitAllReady();
  await party.startMusic();
  await party.setMode("Orchestra");

  for (const target of [1, 2, 3, 5]) {
    if (party.guests.length < target) await party.addGuests(target - party.guests.length);
    // Every phone in, decoded and sounding.
    const t0 = performance.now();
    let samples = await party.sampleAll(party.guests);
    while (performance.now() - t0 < 20_000 && samples.some((s) => s.rmsMax1s <= SOUND_RMS)) {
      await sleep(300);
      samples = await party.sampleAll(party.guests);
    }
    await sleep(2500);
    samples = await party.sampleAll(party.guests);
    const carriers = stemCarriers(party);
    // "Audible somewhere" has to mean on a phone that is really making sound.
    const soundingNames = new Set(samples.filter((s) => s.sounding).map((s) => s.name));
    const heard = Object.fromEntries(Object.entries(carriers).map(([stem, who]) => [stem, who.filter((n) => soundingNames.has(n))]));
    steps.push({ guests: target, labels: samples.map((s) => `${s.name}:${s.label}`), heard, spread: party.spread(samples).residualSpreadMs, lateJoinSettleMs: Math.round(performance.now() - t0) });
    party.note(`ORCHESTRA with ${target}:\n` + samples.map(line).join("\n"));
    for (const [stem, who] of Object.entries(heard)) expect.soft(who.length, `${target} guest(s): stem "${stem}" audible on a sounding phone`).toBeGreaterThan(0);
    expect.soft(samples.filter((s) => !s.sounding).map((s) => s.name), `${target} guest(s): every phone sounding`).toEqual([]);
  }
  await party.screenshots("five");

  // A phone leaves (tab closed). Who carried what, and how long until every stem is heard again?
  // Preferably the only phone carrying some stem: that is the case where the room loses a part.
  const carriedNow = stemCarriers(party);
  const soleCarrier = Object.values(carriedNow).find((who) => who.length === 1)?.[0];
  const leaver = party.guests.find((g) => g.name === soleCarrier) ?? party.guests[0]!;
  const leaverName = leaver.name;
  const leaverStems = Object.entries(leaver.me?.assignment?.gainsDb ?? {})
    .filter(([, db]) => db > AUDIBLE_DB)
    .map(([s]) => s);
  const before = stemCarriers(party);
  const soleStems = leaverStems.filter((s) => (before[s] ?? []).length === 1);
  const leftAt = performance.now();
  await party.removeGuest(leaver);
  let healedMs: number | null = null;
  let carriers = stemCarriers(party);
  while (performance.now() - leftAt < 30_000) {
    carriers = stemCarriers(party);
    if (Object.values(carriers).every((who) => who.length > 0) && !Object.values(carriers).some((who) => who.includes(leaverName))) {
      healedMs = Math.round(performance.now() - leftAt);
      break;
    }
    await sleep(100);
  }
  await sleep(2000);
  const after = await party.sampleAll(party.guests);
  party.metrics.orchestra = { steps, leave: { leaver: leaverName, leaverStems, stemsOnlyTheLeaverCarried: soleStems, healedMs, carriersAfter: carriers, labelsAfter: after.map((s) => `${s.name}:${s.label}`) } };
  party.note(`after ${leaverName} left:\n` + after.map(line).join("\n"));
  expect.soft(healedMs, `every stem is carried by a connected phone again within 30 s of ${leaverName} leaving`).not.toBeNull();
  if (healedMs !== null) expect.soft(healedMs, "time for a leaver's stem to be handed to another phone (ms)").toBeLessThan(5000);
  expect.soft(after.filter((s) => !s.sounding).map((s) => s.name), "the remaining phones all still sound").toEqual([]);
  await party.screenshots("after-leave");
  await checkIssues(party);
});

test.describe("02c-strobe", () => {
  // A continuous tone under the kick: any silence the room hears is the strobe's, not the song's.
  test.use({ library: { seed: [{ id: "strobe-tone", title: "Strobe Tone", seconds: 200, toneHz: 440 }] } });
  test("02c-strobe: every beat division × group count, then more groups than phones — no dead air", async ({ party }) => {
    await party.begin(8, { song: "Strobe Tone" });
    const host = party.host.page;
    party.metrics.bpm = party.host.room?.track?.bpm ?? null;
    party.note(`track bpm as analysed by the server: ${party.host.room?.track?.bpm}`);

    // Baseline: the same measurement in UNISON.
    await sleep(6000);
    const baseline = await deadAirOver(party, party.guests, 5000);
    party.metrics.unisonBaseline = { coveredPct: baseline.coveredPct, longestMs: baseline.longestMs };

    await party.setMode("Strobe");
    const chips = async () => (await host.getByTestId("strobe-groups").getByRole("button").allInnerTexts()).map(Number);
    party.metrics.groupChipsWith8Phones = await chips();
    expect.soft(await chips(), "group chips offered with 8 phones").toEqual([2, 3, 4, 5, 6, 8]);

    const matrix: Array<Record<string, unknown>> = [];
    const measure = async (label: string, devices: Device[]) => {
      await sleep(1200); // let the pattern change land (it is applied on a boundary)
      const from = await devices[0]!.pageWall();
      await sleep(5000);
      // 100 ms buckets: each phone's 20 Hz sampler lands twice in every bucket, so one late timer tick
      // on the only phone whose turn it is cannot read as a hole (with 50 ms buckets it did).
      const dead = await party.deadAir(devices, from, from + 5000, 100);
      const samples = await party.sampleAll(devices);
      const effective = new Set(samples.map((s) => party.guests.find((g) => g.name === s.name)?.me?.assignment?.pattern?.phaseMs ?? null)).size;
      const row = {
        label,
        coveredPct: dead.coveredPct,
        longestGapMs: dead.longestMs,
        gaps: dead.gaps.length,
        distinctPhases: effective,
        periodMs: party.guests[0]?.me?.assignment?.pattern?.periodMs ?? null,
        duty: party.guests[0]?.me?.assignment?.pattern?.duty ?? null,
        onPct: Object.values(dead.perDeviceSoundingPct),
        spread: party.spread(samples).residualSpreadMs,
      };
      matrix.push(row);
      expect.soft(dead.longestMs, `STROBE ${label}: longest stretch with no phone sounding (ms)`).toBeLessThanOrEqual(Math.max(100, baseline.longestMs + 50));
      expect.soft(dead.coveredPct, `STROBE ${label}: share of time some phone was sounding (%)`).toBeGreaterThanOrEqual(baseline.coveredPct - 3);
      return row;
    };

    for (const groups of [2, 3, 4, 8]) {
      await host.getByTestId("strobe-groups").getByRole("button", { name: String(groups), exact: true }).click();
      for (const division of ["1/2", "1/4", "1/8", "1/16"]) {
        await host.getByRole("button", { name: division, exact: true }).click();
        await measure(`${division} × ${groups} groups, 8 phones`, party.guests);
      }
    }
    await party.screenshots("eight-groups");

    // More groups than phones: 8 groups are running; five phones walk out.
    for (const g of party.guests.slice(3)) await party.removeGuest(g);
    await sleep(2500);
    party.metrics.groupChipsWith3Phones = await chips();
    party.metrics.requestedGroupsAfterLeave = party.host.room?.mode.params.groups ?? null;
    expect.soft((await chips()).every((c) => c <= 3), `group chips offered with 3 phones are at most 3 (${await chips()})`).toBe(true);
    for (const division of ["1/2", "1/4", "1/8", "1/16"]) {
      await host.getByRole("button", { name: division, exact: true }).click();
      await measure(`${division} × 8 requested, 3 phones left`, party.guests);
    }
    party.metrics.strobe = matrix;
    party.note("strobe matrix:\n" + matrix.map((m) => JSON.stringify(m)).join("\n"));
    await party.screenshots("three-left");
    await checkIssues(party);
  });
});

test("02d-choir: render time, what plays meanwhile, switching away and switching songs mid-render", async ({ party }) => {
  await party.begin(4, { song: "Synthetic 60" });
  await sleep(4000);
  const baseBuffers = Object.fromEntries((await party.sampleAll(party.guests)).map((s) => [s.name, s.bufferId]));

  /** Follows the guests until every pitched phone plays a different buffer than it started on. */
  const followChoir = async (timeoutMs: number) => {
    const t0 = performance.now();
    const swappedAt: Record<string, number | null> = Object.fromEntries(party.guests.map((g) => [g.name, null]));
    const silentMs: Record<string, number> = Object.fromEntries(party.guests.map((g) => [g.name, 0]));
    const unpitchedSoundingMs: Record<string, number> = Object.fromEntries(party.guests.map((g) => [g.name, 0]));
    let worstStall = 0;
    let last = t0;
    while (performance.now() - t0 < timeoutMs) {
      const samples = await party.sampleAll(party.guests);
      const now = performance.now();
      for (const s of samples) {
        const pitch = party.guests.find((g) => g.name === s.name)?.me?.assignment?.pitchSemitones ?? 0;
        worstStall = Math.max(worstStall, s.stallMs ?? 0);
        if (s.rms <= SOUND_RMS) silentMs[s.name]! += now - last;
        if (pitch !== 0 && swappedAt[s.name] === null) {
          if (s.bufferId !== null && s.bufferId !== baseBuffers[s.name]) swappedAt[s.name] = Math.round(now - t0);
          else if (s.rms > SOUND_RMS) unpitchedSoundingMs[s.name]! += now - last;
        }
      }
      last = now;
      const pitched = party.guests.filter((g) => (g.me?.assignment?.pitchSemitones ?? 0) !== 0);
      if (pitched.length && pitched.every((g) => swappedAt[g.name] !== null) && now - t0 > 3000) break;
      await sleep(150);
    }
    return { swappedAt, silentMs: Object.fromEntries(Object.entries(silentMs).map(([k, v]) => [k, Math.round(v)])), unpitchedSoundingMs: Object.fromEntries(Object.entries(unpitchedSoundingMs).map(([k, v]) => [k, Math.round(v)])), worstStallMs: worstStall };
  };

  // 1. CHOIR switched on mid-song.
  await party.setMode("Choir");
  const first = await followChoir(60_000);
  await sleep(2000);
  const inChoir = await party.sampleAll(party.guests);
  const pitches = Object.fromEntries(party.guests.map((g) => [g.name, g.me?.assignment?.pitchSemitones ?? 0]));
  party.metrics.choirMidSong = { pitches, renderMs: first.swappedAt, silentMsDuringRender: first.silentMs, playedUnpitchedMs: first.unpitchedSoundingMs, worstMainThreadStallMs: first.worstStallMs, spreadAfter: party.spread(inChoir) };
  party.note("CHOIR settled:\n" + inChoir.map(line).join("\n"));
  for (const [name, p] of Object.entries(pitches)) {
    if (p !== 0) expect.soft(first.swappedAt[name], `${name} (pitch ${p}) never swapped to its pitched render`).not.toBeNull();
  }
  expect.soft(inChoir.filter((s) => !s.sounding).map((s) => s.name), "CHOIR: every phone sounding once rendered").toEqual([]);
  for (const [name, ms] of Object.entries(first.silentMs)) expect.soft(ms, `${name}: silent time while CHOIR rendered (ms)`).toBeLessThan(700);
  const sp = party.spread(inChoir).residualSpreadMs;
  if (sp !== null) expect.soft(sp, "CHOIR: sync spread once pitched (ms)").toBeLessThan(15);
  await party.screenshots("choir");

  // 2. Back to UNISON: everyone returns to the original audio.
  await party.setMode("Unison");
  await sleep(3000);
  const backToUnison = await party.sampleAll(party.guests);
  party.metrics.backToUnison = { onOriginalBuffer: backToUnison.map((s) => `${s.name}:${s.bufferId === baseBuffers[s.name]}`), sounding: backToUnison.filter((s) => s.sounding).length };
  expect.soft(backToUnison.filter((s) => s.bufferId !== baseBuffers[s.name]).map((s) => s.name), "after CHOIR → UNISON every phone is back on the unpitched audio").toEqual([]);
  expect.soft(backToUnison.filter((s) => !s.sounding).map((s) => s.name), "after CHOIR → UNISON every phone sounds").toEqual([]);

  // 3. Switch songs, then CHOIR on the new song and away again mid-render.
  await party.pickSong("Synthetic 30");
  await party.waitAllReady();
  await party.startMusic();
  await sleep(2500);
  const base2 = Object.fromEntries((await party.sampleAll(party.guests)).map((s) => [s.name, s.bufferId]));
  await party.setMode("Choir");
  await sleep(250); // mid-render
  await party.setMode("Stereo");
  await sleep(6000);
  const afterAbort = await party.sampleAll(party.guests);
  party.metrics.switchAwayMidRender = { onOriginalBuffer: afterAbort.map((s) => `${s.name}:${s.bufferId === base2[s.name]}`), sounding: afterAbort.filter((s) => s.sounding).length, spread: party.spread(afterAbort).residualSpreadMs, labels: afterAbort.map((s) => s.label) };
  expect.soft(afterAbort.filter((s) => s.bufferId !== base2[s.name]).map((s) => s.name), "CHOIR abandoned mid-render: no phone ends up playing a pitched buffer in STEREO").toEqual([]);
  expect.soft(afterAbort.filter((s) => !s.sounding).map((s) => s.name), "CHOIR abandoned mid-render: every phone sounds").toEqual([]);

  // 4. CHOIR, then a different song mid-render: the new song must play (pitched, eventually), not the old render.
  await party.setMode("Choir");
  await sleep(250);
  await party.pickSong("Synthetic 60");
  await party.waitAllReady();
  const tts = await party.startMusic();
  const second = await followChoir(60_000);
  await sleep(1500);
  const end = await party.sampleAll(party.guests);
  party.metrics.switchSongMidRender = { timeToSoundMs: tts, renderMs: second.swappedAt, trackOnPhones: end.map((s) => s.trackId), sounding: end.filter((s) => s.sounding).length, spread: party.spread(end).residualSpreadMs, positions: end.map((s) => round(s.posSec, 2)) };
  party.note("after song switch mid-render:\n" + end.map(line).join("\n"));
  expect.soft(end.filter((s) => !s.sounding).map((s) => s.name), "song switched mid-CHOIR-render: every phone sounds on the new song").toEqual([]);
  const sp2 = party.spread(end).residualSpreadMs;
  if (sp2 !== null) expect.soft(sp2, "song switched mid-CHOIR-render: sync spread (ms)").toBeLessThan(15);
  await party.screenshots("end");
  await checkIssues(party);
});

test.describe("02f-wave-drag", () => {
  test.use({ library: { synthetic: ["synthetic-60s"] } });
  test("02f-wave-drag: dragging a dot on the host map moves that phone's delay, and its playhead follows", async ({ party }) => {
    await party.begin(3);
    await party.setMode("Wave");
    await sleep(4000);
    const target = party.guests[0]!;
    const before = await target.sample();
    const delayBefore = target.me?.assignment?.delayMs ?? null;
    const positionBefore = target.me?.position ?? null;

    // Drag the dot to the far right edge of the map, then to the far left.
    const svg = party.host.page.locator('svg[aria-label^="Hive map"]');
    const box = (await svg.boundingBox())!;
    const dot = svg.locator(`g[data-client-id="${target.clientId}"]`);
    const drag = async (toX: number) => {
      const d = (await dot.boundingBox())!;
      await party.host.page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
      await party.host.page.mouse.down();
      for (let i = 1; i <= 8; i++) await party.host.page.mouse.move(d.x + d.width / 2 + ((toX - d.x - d.width / 2) * i) / 8, d.y + d.height / 2, { steps: 2 });
      await party.host.page.mouse.up();
      await sleep(3500);
      const s = await target.sample();
      return { delayMs: target.me?.assignment?.delayMs ?? null, x: round(target.me?.position?.x ?? null, 2), errMs: round(s.errMs), residualMs: round(s.residualMs), sounding: s.sounding };
    };
    const right = await drag(box.x + box.width * 0.93);
    const left = await drag(box.x + box.width * 0.07);
    party.metrics.waveDrag = { before: { delayMs: delayBefore, x: round(positionBefore?.x ?? null, 2), errMs: round(before.errMs), residualMs: round(before.residualMs) }, right, left };
    party.note(`wave drag: ${JSON.stringify(party.metrics.waveDrag)}`);
    await party.screenshots("dragged");
    expect.soft(right.delayMs, "dragging a dot to the right edge changes its delay").not.toBe(delayBefore);
    expect.soft(Math.abs((right.delayMs ?? 0) - (left.delayMs ?? 0)), "right edge vs left edge delay differ by most of the wave span (ms)").toBeGreaterThan(150);
    // The measured playhead must move by the delay: the residual (error net of the intended delay) stays small.
    for (const [where, r] of [["right", right], ["left", left]] as const) {
      expect.soft(r.sounding, `after the drag to the ${where} the phone still sounds`).toBe(true);
      if (r.residualMs !== null) expect.soft(Math.abs(r.residualMs), `after the drag to the ${where}: playhead error net of the new delay (ms)`).toBeLessThan(12);
    }
    await checkIssues(party);
  });
});
