import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

test("F0: /diag connects and shows clientId, connection open, rtt, offset, audio ready", async ({ page }) => {
  await page.goto("/diag");
  await page.getByLabel("Room code").fill("BZQ7");
  await page.getByRole("button", { name: "Tap to connect" }).click();

  await expect(page.getByText("clientId")).toBeVisible();
  await expect(page.getByText("open", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("audio.state")).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 10_000 });

  const rttRow = page.locator("div").filter({ hasText: /^rttMs/ }).last();
  await expect(rttRow).toContainText("ms");
  const offsetRow = page.locator("div").filter({ hasText: /^clockOffsetMs/ }).last();
  await expect(offsetRow).toContainText("ms");
});
