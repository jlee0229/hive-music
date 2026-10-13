import { test, expect } from "./test";
import { round, sleep, type DeviceSample } from "./harness";

/**
 * Scenario 8 — scale soak: PARTY_SOAK_GUESTS phones (default 30) + the host, PARTY_SOAK_SEC seconds
 * (default 90) of STROBE and then of ORCHESTRA. Every phone sounding, the sync spread, the server's
 * /health counts, its memory and CPU, the pages' JS heap, and every console error.
 */
const GUESTS = Number(process.env.PARTY_SOAK_GUESTS ?? 30);
const SECONDS = Number(process.env.PARTY_SOAK_SEC ?? 90);

test(`08-soak: ${GUESTS} guests, ${SECONDS} s STROBE then ${SECONDS} s ORCHESTRA`, async ({ party, server }) => {
  const joinStarted = performance.now();
  await party.hostFromLanding();
  await party.pickSongIfNeeded("Synthetic 60");
  await party.addGuests(GUESTS, "G", { batch: 6, iosEvery: 4 });
  const readyMs = Math.round(await party.waitAllReady(120_000));
  party.metrics.join = { guests: GUESTS, allJoinedAndReadyMs: Math.round(performance.now() - joinStarted), readyWaitMs: readyMs };
  const stats0 = await server.current.stats();

  const startedAt = performance.now();
  const tts = await party.startMusic(120_000);
  const ttsValues = Object.values(tts).filter((x): x is number => x !== null);
  party.metrics.start = { tapToAllSoundingMs: ttsValues.length === GUESTS ? Math.max(...ttsValues) : null, neverSounded: Object.entries(tts).filter(([, v]) => v === null).map(([k]) => k), startTookMs: Math.round(performance.now() - startedAt) };
  expect.soft(Object.entries(tts).filter(([, v]) => v === null).map(([k]) => k), "phones that never made a sound after Start").toEqual([]);
  await party.screenshots("started");

  const phases: Record<string, unknown> = {};
  for (const mode of ["Strobe", "Orchestra"] as const) {
    await party.setMode(mode);
    await sleep(2000);
    const cpu0 = await server.current.stats();
    const t0 = performance.now();
    const rows: Array<{ atSec: number; sounding: number; spread: number | null; maxAbs: number | null; health: unknown; rssMb: number | null; heapMb: number | null; stallMs: number; stateKb: number | null; betweenSongs: boolean; silent: string[] }> = [];
    while (performance.now() - t0 < SECONDS * 1000) {
      const samples: DeviceSample[] = await party.sampleAll(party.guests);
      const sp = party.spread(samples);
      const st = await server.current.stats();
      const heaps = samples.map((s) => s.heapMb).filter((x): x is number => x !== null);
      const hostState = party.host.stateBytes.at(-1) ?? null;
      const betweenSongs = samples.every((s) => s.expectedSec !== null && s.expectedSec < 0.5);
      rows.push({
        atSec: round((performance.now() - t0) / 1000)!,
        sounding: sp.sounding,
        spread: sp.residualSpreadMs,
        maxAbs: sp.residualMaxAbsMs,
        health: await server.current.health(),
        rssMb: st?.rssMb ?? null,
        heapMb: heaps.length ? Math.max(...heaps) : null,
        stallMs: Math.max(...samples.map((s) => s.stallMs ?? 0)),
        stateKb: hostState === null ? null : round(hostState / 1024),
        betweenSongs,
        silent: betweenSongs ? [] : samples.filter((s) => !s.sounding).map((s) => s.name),
      });
      await sleep(5000);
    }
    const cpu1 = await server.current.stats();
    const wallMs = performance.now() - t0;
    const spreads = rows.map((r) => r.spread).filter((x): x is number => x !== null);
    const guestState = party.guests[0]!.stateBytes.at(-1) ?? null;
    phases[mode] = {
      ticks: rows.length,
      minSounding: Math.min(...rows.filter((r) => !r.betweenSongs).map((r) => r.sounding)),
      silentTicks: rows.filter((r) => r.silent.length).map((r) => `${r.atSec}s: ${r.silent.slice(0, 6).join(",")}${r.silent.length > 6 ? ` (+${r.silent.length - 6})` : ""}`),
      spreadMs: { median: spreads.slice().sort((a, b) => a - b)[spreads.length >> 1] ?? null, worst: spreads.length ? Math.max(...spreads) : null },
      serverRssMb: { first: rows[0]?.rssMb ?? null, last: rows.at(-1)?.rssMb ?? null, max: Math.max(...rows.map((r) => r.rssMb ?? 0)) },
      serverCpuPct: cpu0 && cpu1 ? round((100 * (cpu1.cpuMs - cpu0.cpuMs)) / wallMs) : null,
      pageHeapMbMax: Math.max(...rows.map((r) => r.heapMb ?? 0)),
      worstMainThreadStallMs: Math.max(...rows.map((r) => r.stallMs)),
      hostStateKb: rows.at(-1)?.stateKb ?? null,
      guestStateKb: guestState === null ? null : round(guestState / 1024),
      health: rows.at(-1)?.health ?? null,
      series: rows.map((r) => `${r.atSec}s snd=${r.sounding} spread=${r.spread} rss=${r.rssMb} stall=${r.stallMs}${r.betweenSongs ? " (between songs)" : ""}`),
    };
    party.note(`${mode}: ${JSON.stringify(phases[mode])}`);
    await party.screenshots(mode.toLowerCase());
    const p = phases[mode] as { silentTicks: string[]; spreadMs: { worst: number | null } };
    expect.soft(p.silentTicks, `${mode}: phones silent during the soak`).toEqual([]);
    if (p.spreadMs.worst !== null) expect.soft(p.spreadMs.worst, `${mode}: worst sync spread across ${GUESTS} phones (ms)`).toBeLessThan(25);
  }
  const stats1 = await server.current.stats();
  const health = await server.current.health();
  party.metrics.soak = { phases, serverRssMbBefore: stats0?.rssMb ?? null, serverRssMbAfter: stats1?.rssMb ?? null, health };
  expect.soft(health?.clients, "/health counts every phone plus the host").toBe(GUESTS + 1);
  expect.soft(health?.connections, "/health connections").toBe(GUESTS + 1);
  const reconnects = party.guests.filter((g) => g.wsLog.filter((e) => e.event === "open").length > 1).map((g) => g.name);
  party.metrics.guestsThatReconnected = reconnects;
  expect.soft(reconnects, "guests whose socket dropped and reconnected during the soak").toEqual([]);
  party.metrics.issuesAll = party.issues();
  expect.soft(party.unexpectedIssues(), "console errors / page errors / failed requests in any context").toEqual([]);
});
