import { test, expect } from "./fixtures";

// transport stopped, no active calibration: a fresh joiner should land on Ready, not Playing/Calibrating.
test.use({ mockScenario: "join.json" });

test("F1: join reaches Ready with audio === 'ready' and the role card shows the assignment color", async ({ page }) => {
  await page.goto("/j/BZQ7");

  await expect(page.getByText("Joining a hive")).toBeVisible();
  await page.getByPlaceholder("Your name").fill("Playwright Test");
  await page.getByRole("button", { name: "Tap to join" }).click();

  // Ready screen: sync ring + "Synced" once syncErrMs resolves, stem progress, You'll play card.
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Downloading the song")).toBeVisible();
  await expect(page.getByText(/parts/)).toBeVisible();
  await expect(page.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });

  const roleCard = page.locator("span.font-display").last();
  await expect(roleCard).toBeVisible();
  const color = await roleCard.evaluate((el) => getComputedStyle(el).color);
  expect(color).not.toBe("rgb(148, 163, 184)"); // not the placeholder muted grey — a real role color landed

  await expect(page.getByText("Waiting for the host to start")).toBeVisible();
  await expect(page.getByText("Keep your screen on.")).toBeVisible();
});

test("F1: persists the name across a reload", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Persisted Name");
  await page.reload();
  await expect(page.getByPlaceholder("Your name")).toHaveValue("Persisted Name");
});
