/**
 * Room codes are random per hive, so guests arrive with wrong ones all the time: a typo on the
 * landing page, last week's QR, a link pasted with a space in it, a room that died with a deploy.
 */
import { test, expect } from "./fixtures";

// The mock runs exactly one room: BZQ7, transport stopped.
test.use({ mockScenario: "join.json" });

test("a code with no hive behind it says so before the guest types a name or taps anything", async ({ page }) => {
  await page.goto("/j/ZZZZ");

  await expect(page.getByRole("heading", { name: "Hive not found" })).toBeVisible({ timeout: 5_000 });
  // On the page itself (the code is in the tab title too, since each page names itself there).
  await expect(page.locator("main").getByText(/ZZZZ/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Tap to join" })).toHaveCount(0);

  // ...and there is a way forward.
  await page.getByRole("link", { name: "Back home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("Hive code")).toBeVisible();
});

for (const malformed of ["AB", "ABCDEFGHIJ"]) {
  test(`a code of the wrong length (/j/${malformed}) is "not found", not an endless "Syncing…"`, async ({ page }) => {
    await page.goto(`/j/${malformed}`);
    await expect(page.getByRole("heading", { name: "Hive not found" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Syncing…")).toHaveCount(0);
  });
}

for (const messy of ["bzq7", "bz%20q7", "BZ-Q7", "%20BZQ7%20"]) {
  test(`a code typed or pasted untidily (/j/${messy}) still joins the hive`, async ({ page }) => {
    await page.goto(`/j/${messy}`);
    await expect(page.getByText("BZQ7", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  });
}

test("a guest who arrives before the hive exists is let in when it appears", async ({ page }) => {
  let lookups = 0;
  await page.route("**/rooms/BZQ7", (route) => {
    lookups++;
    return lookups === 1 ? route.fulfill({ status: 404, json: { code: "BZQ7", exists: false, players: 0 } }) : route.continue();
  });

  await page.goto("/j/BZQ7");
  await expect(page.getByRole("heading", { name: "Hive not found" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Tap to join" })).toBeVisible({ timeout: 10_000 });
});
