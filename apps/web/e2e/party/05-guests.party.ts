import { test, expect } from "./test";
import { Party, SOUND_RMS, line, round, sleep, type Device } from "./harness";

/**
 * Scenario 5 — guests behaving like guests: joining late, reloading, backgrounding the tab, an
 * interrupted audio session, mute, leaving, being removed.
 */

/** ms until `d` is sounding and within `tolMs` of the other guests' residual, or null. */
async function timeToInSync(party: Party, d: Device, others: Device[], timeoutMs: number, tolMs = 10) {
  const t0 = performance.now();
  let soundAt: number | null = null;
  let syncAt: number | null = null;
  let lastResidualGap: number | null = null;
  while (performance.now() - t0 < timeoutMs) {
    const [s, ...rest] = await party.sampleAll([d, ...others]);
    const ref = rest.map((r) => r.residualMs).filter((x): x is number => x !== null);
    if (s!.rms > SOUND_RMS) soundAt ??= Math.round(performance.now() - t0);
    if (s!.residualMs !== null && ref.length) {
      const mean = ref.reduce((a, b) => a + b, 0) / ref.length;
      lastResidualGap = round(s!.residualMs - mean);
      if (soundAt !== null && Math.abs(s!.residualMs - mean) < tolMs) {
        syncAt = Math.round(performance.now() - t0);
        break;
      }
    }
    await sleep(60);
  }
  return { soundMs: soundAt, inSyncMs: syncAt, offsetFromOthersMs: lastResidualGap };
}

test("05-guests: late join, reload, hidden tab, interrupted audio, mute, leave, kick", async ({ party }) => {
  await party.begin(3, { song: "Synthetic 60" });
  await sleep(3000);
  const steady = () => party.guests.slice(0, 2);
  const m: Record<string, unknown> = {};
  party.metrics.guests = m; // by reference: whatever was measured survives a later step throwing

  // a. Join mid-song.
  {
    const t0 = performance.now();
    const late = await party.addGuest("Latecomer");
    const r = await timeToInSync(party, late, steady(), 20_000);
    m.lateJoin = { ...r, tapToSoundMs: r.soundMs === null ? null : Math.round(r.soundMs + 0), wallMs: Math.round(performance.now() - t0), sawResume: (await late.sample()).seen["Tap to resume"] ?? 0 };
    expect.soft(r.soundMs, "late joiner makes sound").not.toBeNull();
    if (r.soundMs !== null) expect.soft(r.soundMs, "late joiner: tap → sound (ms)").toBeLessThan(2500);
    expect.soft(r.inSyncMs, "late joiner lands at the room's position").not.toBeNull();
  }

  // b. Reload mid-song.
  {
    const d = party.guests[2]!;
    await d.page.reload();
    await sleep(1500);
    const afterReload = await d.sample();
    const needsTap = afterReload.screen === "guest:join";
    let r: Awaited<ReturnType<typeof timeToInSync>> | null = null;
    if (needsTap) {
      await d.page.getByRole("button", { name: "Tap to join" }).click();
      r = await timeToInSync(party, d, steady(), 20_000);
    } else r = await timeToInSync(party, d, steady(), 20_000);
    const nameKept = await d.page.evaluate(() => localStorage.getItem("hive:name"));
    m.reload = { screenAfterReload: afterReload.screen, needsTapAgain: needsTap, nameRemembered: nameKept, ...r, playersOnHost: Object.values(party.host.room!.clients).filter((c) => c.kind === "player" && c.connected).length };
    expect.soft(r.inSyncMs, "reloaded guest is back in sync after (at most) one tap").not.toBeNull();
    expect.soft(Object.values(party.host.room!.clients).filter((c) => c.kind === "player").length, "a reload does not leave a duplicate player record").toBe(4);
  }

  // c1. The tab reports hidden for 10 s (app switch), then visible.
  {
    const d = party.guests[2]!;
    const setVisibility = (state: "hidden" | "visible") =>
      d.page.evaluate((s) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    const startsBefore = (await d.sample()).startCalls;
    await setVisibility("hidden");
    await sleep(10_000);
    const whileHidden = await d.sample();
    await setVisibility("visible");
    const r = await timeToInSync(party, d, steady(), 10_000);
    const after = await d.sample();
    m.hidden10s = { soundingWhileHidden: whileHidden.rms > SOUND_RMS, screenAfter: after.screen, restartsCaused: after.startCalls - startsBefore, ...r };
    expect.soft(r.inSyncMs, "after 10 s hidden the phone is sounding and in sync").not.toBeNull();
  }

  // c2. The page is frozen for 30 s (what a backgrounded mobile tab is), then resumed.
  {
    const d = party.guests[2]!;
    const cdp = await d.context.newCDPSession(d.page);
    const frozenAt = performance.now();
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await sleep(30_000);
    const hostSaw = party.host.room!.clients[d.clientId!]?.connected ?? null;
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    const r = await timeToInSync(party, d, steady(), 20_000);
    const after = await d.sample();
    m.frozen30s = { frozenForMs: Math.round(performance.now() - frozenAt), hostSawConnectedWhileFrozen: hostSaw, screenAfter: after.screen, wsOpenAfter: after.wsOpen, sawReconnecting: after.seen["Reconnecting"] ?? 0, ...r };
    party.note("after frozen 30 s: " + line(after));
    expect.soft(r.inSyncMs, "after 30 s frozen the phone comes back sounding and in sync on its own").not.toBeNull();
    await cdp.detach().catch(() => {});
  }

  // d. The audio session is interrupted (AudioContext.suspend from the page) → "Tap to resume".
  {
    const d = party.guests[1]!;
    await d.page.evaluate(() => (window as unknown as { __party: { ctxs: AudioContext[] } }).__party.ctxs.at(-1)!.suspend());
    const t0 = performance.now();
    let promptMs: number | null = null;
    while (performance.now() - t0 < 8000 && promptMs === null) {
      if ((await d.sample()).screen === "guest:resume") promptMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    await d.screenshot("05-guests-resume-prompt.png");
    let r: Awaited<ReturnType<typeof timeToInSync>> | null = null;
    if (promptMs !== null) {
      await d.page.getByRole("button", { name: "Tap to resume" }).click();
      r = await timeToInSync(party, d, [party.guests[0]!], 10_000);
    }
    const after = await d.sample();
    m.interrupted = { resumePromptMs: promptMs, screenAfter: after.screen, ctxAfter: after.ctxState, ...(r ?? {}) };
    expect.soft(promptMs, 'a suspended AudioContext brings up "Tap to resume"').not.toBeNull();
    expect.soft(r?.inSyncMs ?? null, "one tap resumes the sound, in sync").not.toBeNull();
  }

  // e. Mute / unmute.
  {
    const d = party.guests[0]!;
    await d.page.getByRole("button", { name: "Mute my phone" }).click();
    await sleep(800);
    const muted = await d.sample();
    await d.page.getByRole("button", { name: "Unmute my phone" }).click();
    const r = await timeToInSync(party, d, [party.guests[1]!], 5000);
    m.mute = { rmsWhileMuted: round(muted.rms, 4), saysMuted: /Muted/.test(muted.text), unmute: r };
    expect.soft(muted.rms, "a muted phone is silent").toBeLessThan(SOUND_RMS);
    expect.soft(r.inSyncMs, "unmuted phone sounds again, in sync").not.toBeNull();
  }
  await party.screenshots("mid");

  // f. Leave (tab closed).
  {
    const d = party.guests[3]!; // the latecomer
    const t0 = performance.now();
    await party.removeGuest(d);
    let goneMs: number | null = null;
    while (performance.now() - t0 < 10_000 && goneMs === null) {
      const connected = Object.values(party.host.room!.clients).filter((c) => c.kind === "player" && c.connected).length;
      if (connected === 3) goneMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    await sleep(700);
    m.leave = { hostNoticedMs: goneMs, hostHeader: (await party.host.sample()).text.match(/\d+ players/)?.[0] ?? null };
    expect.soft(goneMs, "the host sees a guest leave").not.toBeNull();
  }

  // g. Kicked from the host's player sheet.
  {
    const d = party.guests[2]!;
    const host = party.host.page;
    await host.locator(`svg[aria-label^="Hive map"] g[data-client-id="${d.clientId}"]`).click();
    await host.getByRole("button", { name: "Remove from hive" }).click();
    const t0 = performance.now();
    let removedMs: number | null = null;
    while (performance.now() - t0 < 8000 && removedMs === null) {
      if ((await d.sample()).screen === "guest:removed") removedMs = Math.round(performance.now() - t0);
      else await sleep(100);
    }
    await sleep(1000);
    const after = await d.sample();
    await d.screenshot("05-guests-kicked.png");
    m.kick = { removedScreenMs: removedMs, rmsAfter: round(after.rms, 4), ctxAfter: after.ctxState, text: after.text.slice(0, 80), wsOpen: after.wsOpen };
    expect.soft(removedMs, "a kicked guest is told it was removed").not.toBeNull();
    expect.soft(after.rms, "a kicked guest goes silent").toBeLessThan(SOUND_RMS);
    const others = await party.sampleAll(party.guests.slice(0, 2));
    expect.soft(others.filter((s) => !s.sounding).map((s) => s.name), "the kick did not silence anyone else").toEqual([]);
  }

  party.metrics.guests = m;
  party.note(JSON.stringify(m));
  await party.screenshots("end");
  party.metrics.issuesAll = party.issues();
  expect.soft(party.unexpectedIssues(/^KICKED: removed by host/), "console errors / page errors / failed requests in any context").toEqual([]);
});
