import { test, expect } from "./fixtures";

test.use({ mockScenario: "restart.json" });
test.setTimeout(60_000);

test("host restart: the stage rides out a dropped server connection and is still the host afterwards", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  const clientIdBefore = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));

  // restart.json: the mock closes every socket 20 s in (close code 1012), keeping the room.
  await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Reconnecting to the hive")).not.toBeVisible({ timeout: 10_000 });

  // Same identity, still on the stage, and the controls still reach the server.
  expect(await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"))).toBe(clientIdBefore);
  await expect(page.getByText("HOST", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /This hive/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 5_000 });
});
