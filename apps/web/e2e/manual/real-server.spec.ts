/**
 * Not part of the mock-driven gate suite: this exercises apps/web against the real @hive/server
 * (still with NEXT_PUBLIC_HIVE_ENGINE=stub, since createHiveClient isn't implemented yet; that
 * swap is gate F8). Useful ahead of F8 to catch protocol/REST drift between the mock and the real
 * server early. Self-skips (not fails) when the real server isn't reachable, so it's harmless in
 * a full `bunx playwright test` run that only has the mock available.
 *
 * Run for real:
 *   ROOM_FIXED_CODE=BZQ7 CORS_ORIGIN=http://localhost:3000 bun run --cwd apps/server dev
 *   bun run --cwd apps/web dev            # apps/web/.env.local already points at :8080
 *   cd apps/web && bunx playwright test e2e/manual/real-server.spec.ts
 */
import { test, expect } from "@playwright/test";

test("real server: host lobby, player join/ready, start, map, tuning", async ({ browser }) => {
  const reachable = await fetch("http://localhost:8080/health")
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!reachable, "real @hive/server is not running on :8080 (this is the mock-server port when it's up instead)");


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
  await playerPage.getByPlaceholder("Your name").fill("RealServer Test");
  await playerPage.getByRole("button", { name: "Tap to join" }).click();
  await expect(playerPage.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(playerPage.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });

  await expect(hostPage.getByText("1 joined")).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeEnabled({ timeout: 15_000 });
  await hostPage.getByRole("button", { name: /Start the hive|Start anyway/ }).click();

  await expect(hostPage.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  await expect(playerPage.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.locator('svg[aria-label^="Hive map"] g[data-client-id]')).toHaveCount(1, { timeout: 10_000 });

  await hostPage.getByRole("button", { name: "Tune the hive" }).click();
  await expect(hostPage.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
  await expect(playerPage.getByText("Hold still.")).toBeVisible({ timeout: 10_000 });

  expect(errors, errors.join("\n")).toHaveLength(0);
  await hostCtx.close();
  await playerCtx.close();
});
