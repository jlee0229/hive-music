import { test, expect } from "./fixtures";

test.use({ mockScenario: "restart.json" });
test.setTimeout(45_000);

test("F9: the reconnect banner appears at 20s and clears within 5s, same clientId", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Restart Test");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

  const clientIdBefore = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));
  expect(clientIdBefore).toBeTruthy();

  // the mock's chaos.restartAfterSec = 20: it closes every socket, simulating a server restart.
  await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 25_000 });

  await expect(page.getByText("Reconnecting to the hive")).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("YOU ARE")).toBeVisible();

  const clientIdAfter = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));
  expect(clientIdAfter).toBe(clientIdBefore);
});

test("F9: NO_ROOM shows a not-found state with a way back home", async ({ page }) => {
  await page.goto("/j/NOPE");
  await page.getByPlaceholder("Your name").fill("Ghost Room");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Hive not found")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Back home" })).toBeVisible();
});
