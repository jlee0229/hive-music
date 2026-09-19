/**
 * Not a check — captures the PNG screenshots gate tables cite as evidence. Run manually per gate,
 * e.g. `bunx playwright test e2e/evidence.spec.ts -g F0`.
 */
import path from "node:path";
import { test, expect } from "./fixtures";

const OUT = path.resolve(__dirname, "../../../evidence/frontend");

test.use({ mockScenario: "party-12.json" });

test("F0 evidence: /diag screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/diag");
  await page.getByLabel("Room code").fill("BZQ7");
  await page.getByRole("button", { name: "Tap to connect" }).click();
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "F0-diag.png") });
});

test.describe("F1 evidence", () => {
  test.use({ mockScenario: "join.json" });

  test("F1 evidence: Ready screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Maya");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F1-ready.png") });
  });
});

test.describe("F2 evidence", () => {
  test.use({ mockScenario: "join.json" });

  test("F2 evidence: Lobby + Stage screenshots", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 980 });
    await page.goto("/h/BZQ7");
    await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F2-lobby.png") });

    await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F2-stage.png") });
  });
});

test.describe("F3 evidence", () => {
  test.use({ mockScenario: "party-12.json" });

  test("F3 evidence: Playing screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Maya");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F3-playing.png") });
  });
});

test.describe("F4 evidence", () => {
  test.use({ mockScenario: "party-12.json" });

  test("F4 evidence: Hive Map screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/h/BZQ7");
    await expect(page.locator('svg[aria-label^="Hive map"] g[data-client-id]')).toHaveCount(12, { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F4-map.png") });
  });
});

test.describe("F9 evidence", () => {
  test.use({ mockScenario: "restart.json" });
  test.setTimeout(45_000);

  test("F9 evidence: reconnect banner screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Restart Test");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 25_000 });
    await page.screenshot({ path: path.join(OUT, "F9-restart.png") });
  });
});

test.describe("F7 evidence", () => {
  test.use({ mockScenario: "calibrating.json" });

  test("F7 evidence: Host Calibrate screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/h/BZQ7");
    await expect(page.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F7-calibrate.png") });
  });
});

test.describe("F6 evidence", () => {
  test.use({ mockScenario: "party-12.json" });

  test("F6 evidence: vibe box + scene strip screenshot", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 980 });
    await page.goto("/h/BZQ7");
    await expect(page.locator('[data-testid="scene-strip"] > div')).toHaveCount(3, { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "F6-vibe.png") });
  });
});
