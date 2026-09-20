/**
 * F8, automatable half: real @hive/server + real createHiveClient (NEXT_PUBLIC_HIVE_ENGINE=real),
 * exercised headlessly. Cannot verify actual audible sync (needs ears + real phones — see
 * evidence/frontend/F8-notes.md and the manual phone checklists), but everything short of that:
 * WebSocket + NTP handshake, AudioContext creation/unlock, AUDIO_READY, transport scheduling,
 * assignment colors, Hive Map, vibe, tuning — all real, not stubbed.
 *
 * Run:
 *   ROOM_FIXED_CODE=BZQ7 CORS_ORIGIN=http://localhost:3000 bun run --cwd apps/server dev
 *   NEXT_PUBLIC_HIVE_ENGINE=real bun run --cwd apps/web dev
 *   cd apps/web && bunx playwright test e2e/manual/real-engine.spec.ts
 */
import { test, expect } from "@playwright/test";

test("real engine: join reaches Ready with real audio state, host starts real playback", async ({ browser }) => {
  const reachable = await fetch("http://localhost:8080/health")
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!reachable, "real @hive/server is not running on :8080");

  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  const playerPage = await playerCtx.newPage();
  const errors: string[] = [];
  hostPage.on("pageerror", (e) => errors.push(`host: ${e.message}`));
  playerPage.on("pageerror", (e) => errors.push(`player: ${e.message}`));

  await hostPage.goto("/h/BZQ7");
  await expect(hostPage.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });

  await playerPage.goto("/j/BZQ7");
  await playerPage.getByPlaceholder("Your name").fill("RealEngine Test");
  await playerPage.getByRole("button", { name: "Tap to join" }).click();

  // Real engine: audio.unlock() actually decodes 4 real WAV stems, not a 480ms fake.
  await expect(playerPage.getByText("Synced", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(playerPage.getByText("Downloading the song")).toBeVisible();
  await expect(playerPage.getByText("4 / 4 parts")).toBeVisible({ timeout: 20_000 });
  await expect(playerPage.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });

  await expect(hostPage.getByText("1 joined")).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeEnabled({ timeout: 20_000 });
  await hostPage.getByRole("button", { name: /Start the hive|Start anyway/ }).click();

  await expect(hostPage.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  await expect(playerPage.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

  // The transport clock should actually advance under the real engine's scheduler.
  const readClock = () => hostPage.locator("span.font-mono", { hasText: / \/ / }).first().innerText();
  const t1 = await readClock();
  await hostPage.waitForTimeout(2000);
  const t2 = await readClock();
  expect(t2).not.toBe(t1);

  // Hive Map renders the real host + real player against the real engine's own assignment.
  await expect(hostPage.locator('svg[aria-label^="Hive map"] g[data-client-id]')).toHaveCount(1, { timeout: 10_000 });

  // Mode switch: a real SET_MODE round trip through the real server + real planner.
  await hostPage.getByRole("button", { name: "Wave", exact: true }).click();
  await expect(hostPage.locator("button", { hasText: "Wave" })).toHaveCSS("font-weight", "600", { timeout: 10_000 });

  // Vibe: a real POST /rooms/:code/vibe (rules fallback, no ANTHROPIC_API_KEY in this environment).
  await hostPage.getByLabel("Describe the vibe").fill("calm then explode at the drop");
  await hostPage.getByRole("button", { name: "Direct" }).click();
  await expect(hostPage.locator('[data-testid="scene-strip"] > div')).toHaveCount(3, { timeout: 15_000 });

  // Tuning moment: a real startCalibration() -> real CALIBRATION_PLAN/SCHEDULED_ACTION round trip.
  await hostPage.getByRole("button", { name: "Tune the hive" }).click();
  await expect(hostPage.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
  await expect(playerPage.getByText("Hold still.")).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join("\n")).toHaveLength(0);
  await hostCtx.close();
  await playerCtx.close();
});
