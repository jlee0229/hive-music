import { test, expect } from "./test";
import { SOUND_RMS, line, sleep, type Device } from "./harness";

/**
 * Scenario 7 — the server process dies mid-party and a new one comes up on the same port and the
 * same fixtures dir (what a deploy or a crash is). Rooms live in memory; the host's signed key is
 * what brings the room back. Measured: does everyone reconnect without touching the phone, is it
 * the same room code, does the music resume or does the stage offer Start, and how long is the
 * party down — per phone, both "socket back" and "sound back".
 */

async function outage(devices: Device[], killedWall: number) {
  return devices.map((d) => {
    const after = d.wsLog.filter((e) => e.at >= killedWall - 500);
    const closed = after.find((e) => e.event === "close");
    const welcomed = after.find((e) => e.event === "welcome" && (!closed || e.at > closed.at));
    return {
      name: d.name,
      noticedMs: closed ? Math.round(closed.at - killedWall) : null,
      rejoinedMs: welcomed ? Math.round(welcomed.at - killedWall) : null,
      socketsOpened: after.filter((e) => e.event === "open").length,
    };
  });
}

test("07a-restart: server restarts mid-song with the host present", async ({ party, server }) => {
  await party.begin(4, { song: "Synthetic 60" });
  await sleep(4000);
  const code = party.code;
  const before = await party.sampleAll();
  party.note("before the restart:\n" + before.map(line).join("\n"));
  const hostIdBefore = party.host.clientId;
  const zeroBefore = party.host.room!.transport.state === "playing" ? party.host.room!.transport.serverTimeAtTrackZero : null;

  const killedWall = performance.timeOrigin + performance.now();
  const killedPerf = performance.now();
  const downMs = await server.restart(3000); // the port is dark for ~3 s
  party.metrics.portDarkMs = Math.round(downMs);

  // What phones did while the server was away, then until everything settles.
  const timeline: Array<{ atMs: number; hostScreen: string; hostWs: boolean; transport: string | null; guestsSounding: number; guestsWs: number; guestScreens: string }> = [];
  let allBackAt: number | null = null;
  let soundBackAt: number | null = null;
  let pressedStartAt: number | null = null;
  while (performance.now() - killedPerf < 45_000) {
    const all = await party.sampleAll();
    const host = all[0]!;
    const guests = all.slice(1);
    const row = {
      atMs: Math.round(performance.now() - killedPerf),
      hostScreen: host.screen,
      hostWs: host.wsOpen,
      transport: host.transport,
      guestsSounding: guests.filter((g) => g.rms > SOUND_RMS).length,
      guestsWs: guests.filter((g) => g.wsOpen).length,
      guestScreens: [...new Set(guests.map((g) => g.screen))].join(","),
    };
    const last = timeline.at(-1);
    if (!last || JSON.stringify({ ...last, atMs: 0 }) !== JSON.stringify({ ...row, atMs: 0 })) timeline.push(row);
    const rejoined = (await outage(party.devices, killedWall)).every((o) => o.rejoinedMs !== null);
    if (rejoined && allBackAt === null) allBackAt = row.atMs;
    // If the room came back stopped, the stage offers Start: a host would press it.
    if (rejoined && pressedStartAt === null && host.screen === "host:stage-stopped" && row.atMs > downMs + 1500) {
      const btn = party.host.page.getByRole("button", { name: /Start the hive|Start anyway/ });
      if ((await btn.count()) && (await btn.isEnabled())) {
        pressedStartAt = row.atMs;
        await btn.click();
      }
    }
    if (rejoined && row.guestsSounding === guests.length && row.atMs > downMs && soundBackAt === null) {
      soundBackAt = row.atMs;
      if (row.atMs > downMs + 8000) break;
    }
    if (soundBackAt !== null && row.atMs > soundBackAt + 5000) break;
    await sleep(250);
  }
  const perDevice = await outage(party.devices, killedWall);
  const after = await party.sampleAll();
  party.note("after the restart:\n" + after.map(line).join("\n"));
  const zeroAfter = party.host.room?.transport.state === "playing" ? party.host.room.transport.serverTimeAtTrackZero : null;
  party.metrics.restart = {
    perDevice,
    allRejoinedMs: allBackAt,
    hostHadToPressStart: pressedStartAt !== null,
    pressedStartAtMs: pressedStartAt,
    allSoundingAgainMs: soundBackAt,
    sameCode: party.host.room?.code === code && party.host.page.url().endsWith(`/h/${code}`),
    hostStillHost: party.host.welcome?.isHost ?? null,
    hostSameClientId: party.host.clientId === hostIdBefore,
    transportAfter: party.host.room?.transport.state ?? null,
    resumedSameTimeline: zeroBefore !== null && zeroAfter === zeroBefore,
    trackAfter: party.host.room?.track?.id ?? null,
    modeAfter: party.host.room?.mode.kind ?? null,
    playersAfter: Object.values(party.host.room?.clients ?? {}).filter((c) => c.kind === "player" && c.connected).length,
    timeline,
    serverLogTail: server.current.log().split("\n").slice(-12),
  };
  await party.screenshots("after");

  for (const o of perDevice) expect.soft(o.rejoinedMs, `${o.name} reconnected on its own`).not.toBeNull();
  expect.soft(party.host.room?.code, "same room code after the restart").toBe(code);
  expect.soft(party.host.welcome?.isHost, "the host is still the host").toBe(true);
  expect
    .soft(
      after.slice(1).filter((s) => s.screen === "guest:not-found" || s.screen === "guest:removed" || s.screen === "guest:join").map((s) => `${s.name}:${s.screen}`),
      "no guest was thrown out by the restart",
    )
    .toEqual([]);
  expect.soft(soundBackAt, "every guest is making sound again within 45 s").not.toBeNull();
  expect.soft(pressedStartAt, "the music came back without the host pressing Start again").toBeNull();
  const sp = party.spread(after.slice(1));
  party.metrics.spreadAfter = sp;
  if (sp.residualSpreadMs !== null) expect.soft(sp.residualSpreadMs, "sync spread after the restart (ms)").toBeLessThan(15);
  // Requests that fail while the server is down are the outage itself, not a second finding.
  party.metrics.issuesAll = party.issues();
  const unexpected = party.unexpectedIssues(/ERR_CONNECTION_REFUSED|WebSocket connection to|Failed to fetch|net::ERR_/);
  expect.soft(unexpected, "errors other than the outage itself").toEqual([]);
});

test("07b-restart: server restarts while the host's tab is closed (guests alone)", async ({ party, server }) => {
  await party.begin(3, { song: "Synthetic 60" });
  await sleep(3000);
  const code = party.code;

  // The host's tab closes (phone locked, tab swiped away); the context — its storage — survives.
  await party.host.page.close();
  await sleep(1500);
  const alone = await party.sampleAll(party.guests);
  party.note("host gone, before the restart:\n" + alone.map(line).join("\n"));
  party.metrics.soundingWithHostGone = alone.filter((s) => s.rms > SOUND_RMS).length;

  const killedWall = performance.timeOrigin + performance.now();
  const killedPerf = performance.now();
  party.metrics.portDarkMs = Math.round(await server.restart(3000));

  const timeline: Array<{ atMs: number; sounding: number; ws: number; screens: string }> = [];
  while (performance.now() - killedPerf < 30_000) {
    const gs = await party.sampleAll(party.guests);
    const row = { atMs: Math.round(performance.now() - killedPerf), sounding: gs.filter((g) => g.rms > SOUND_RMS).length, ws: gs.filter((g) => g.wsOpen).length, screens: [...new Set(gs.map((g) => g.screen))].join(",") };
    const last = timeline.at(-1);
    if (!last || last.sounding !== row.sounding || last.ws !== row.ws || last.screens !== row.screens) timeline.push(row);
    await sleep(300);
  }
  const guestsAlone = await party.sampleAll(party.guests);
  party.note("guests alone, 30 s after the restart:\n" + guestsAlone.map((s) => line(s) + ` | ${s.text.slice(0, 120)}`).join("\n"));
  const roomWhileAlone = await fetch(`http://localhost:${process.env.HIVE_SERVER_PORT ?? 8910}/rooms/${code}`).then((r) => r.status);
  await party.guests[0]!.screenshot("07b-restart-guest-alone.png");

  // The host comes back: same browser, same URL.
  const page = await party.host.context.newPage();
  party.host.attach(page);
  party.host.page = page;
  const backPerf = performance.now();
  await page.goto(`/h/${code}`);
  let hostScreen = "";
  let soundBackAt: number | null = null;
  let pressed = false;
  const hostTimeline: Array<{ atMs: number; host: string; sounding: number; guestScreens: string }> = [];
  while (performance.now() - backPerf < 40_000) {
    const all = await party.sampleAll();
    hostScreen = all[0]!.screen;
    const gs = all.slice(1);
    const row = { atMs: Math.round(performance.now() - backPerf), host: hostScreen, sounding: gs.filter((g) => g.rms > SOUND_RMS).length, guestScreens: [...new Set(gs.map((g) => g.screen))].join(",") };
    const last = hostTimeline.at(-1);
    if (!last || last.host !== row.host || last.sounding !== row.sounding || last.guestScreens !== row.guestScreens) hostTimeline.push(row);
    if (!pressed && hostScreen === "host:stage-stopped" && row.atMs > 2500) {
      const btn = page.getByRole("button", { name: /Start the hive|Start anyway/ });
      if ((await btn.count()) && (await btn.isEnabled())) {
        pressed = true;
        await btn.click();
      }
    }
    if (row.sounding === gs.length && gs.length > 0) {
      soundBackAt ??= row.atMs;
      if (row.atMs > soundBackAt + 3000) break;
    }
    await sleep(300);
  }
  const end = await party.sampleAll();
  party.note("after the host returned:\n" + end.map(line).join("\n"));
  party.metrics.restart = {
    perGuest: await outage(party.guests, killedWall),
    guestsAloneTimeline: timeline,
    guestScreensWhileAlone: guestsAlone.map((s) => `${s.name}:${s.screen}`),
    guestsSoundingWhileAlone: guestsAlone.filter((s) => s.rms > SOUND_RMS).length,
    roomLookupWhileAlone: roomWhileAlone,
    hostReturn: { screen: hostScreen, hadToPressStart: pressed, allSoundingAfterReturnMs: soundBackAt, timeline: hostTimeline },
    sameCode: party.host.room?.code === code,
    hostIsHost: party.host.welcome?.isHost ?? null,
    playersAfter: Object.values(party.host.room?.clients ?? {}).filter((c) => c.kind === "player" && c.connected).length,
    serverLogTail: server.current.log().split("\n").slice(-12),
  };
  await party.screenshots("after");

  expect
    .soft(
      guestsAlone.filter((s) => s.screen === "guest:not-found" || s.screen === "guest:removed").map((s) => `${s.name}:${s.screen}`),
      "guests waiting alone are not told the hive is gone before the host has had a chance to return",
    )
    .toEqual([]);
  expect.soft(hostScreen, "the returning host lands on the stage").toMatch(/^host:stage/);
  expect.soft(party.host.room?.code, "same room code").toBe(code);
  expect.soft(party.metrics.restart && (party.metrics.restart as { playersAfter: number }).playersAfter, "all three guests are back in the room").toBe(3);
  expect.soft(soundBackAt, "every guest sounding again after the host returned").not.toBeNull();
  // PARTY-01: the guests were never refused — each one's JOIN was held by the server until the host's
  // key restored the room, so each is WELCOMEd again on its own, and none ends up on a dead screen.
  for (const o of await outage(party.guests, killedWall)) expect.soft(o.rejoinedMs, `${o.name} was let back into the hive without touching the phone`).not.toBeNull();
  expect.soft(party.guests.flatMap((g) => g.serverErrors.filter((e) => e.at >= killedWall).map((e) => `${g.name}:${e.code}`)), "no guest was sent an ERROR while waiting for the host").toEqual([]);
  expect
    .soft(
      end.slice(1).filter((s) => s.screen !== "guest:playing").map((s) => `${s.name}:${s.screen}`),
      "every guest is on the playing screen once the host has pressed Start",
    )
    .toEqual([]);
  party.metrics.issuesAll = party.issues();
  const unexpected = party.unexpectedIssues(/ERR_CONNECTION_REFUSED|WebSocket connection to|Failed to fetch|net::ERR_/);
  expect.soft(unexpected, "errors other than the outage itself").toEqual([]);
});
