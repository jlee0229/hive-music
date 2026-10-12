import { test, expect } from "./fixtures";

test.describe("tuning moment at a big party", () => {
  test.use({ mockScenario: "party-40.json" });

  test("host layout: with 40 phones in the list, Cancel is still on screen (the list scrolls, the buttons do not leave)", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Tune the hive" }).click();
    await expect(page.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("waiting").first()).toBeVisible();

    const cancel = page.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await cancel.click();
    await expect(page.getByText("Tuning moment")).toHaveCount(0);
  });
});
