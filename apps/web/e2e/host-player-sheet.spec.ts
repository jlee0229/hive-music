import { test, expect } from "./fixtures";

/**
 * The sheet a tap or long-press on a phone opens, and what a tap on the map does: it must always be
 * closable, must not offer the host a way to remove themselves, and must not pin parts where a
 * part cannot be seen or heard.
 */
test.describe("parts only where there are parts", () => {
  test.use({ mockScenario: "join.json" });

  test("host map: in Unison a tap opens the phone's sheet and pins nothing (a part there is invisible state)", async ({ page }) => {
    const sent: string[] = [];
    page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));

    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Unison", exact: true }).click();
    await expect(page.getByText("drag to place · tap a phone for more")).toBeVisible({ timeout: 10_000 });

    await page.locator('g[data-client-id="mock-01-maya"]').click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Drums" })).toHaveCount(0);
    await expect(sheet.getByText("Keep this part when others join")).toBeHidden();
    expect(sent.filter((m) => m.includes('"ASSIGN"'))).toEqual([]);
    // and nothing the page sent was rejected (ticking "Keep this part" in unison used to send role "unison")
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  });
});

test.describe("the per-player sheet", () => {
  test.use({ mockScenario: "party-12.json" });

  for (const [w, h] of [
    [320, 568],
    [667, 375],
  ] as const) {
    test(`host layout: the player sheet can be closed at ${w}x${h} without removing the player`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/h/BZQ7");
      await page.getByRole("button", { name: "Players", exact: true }).click();
      await page.getByRole("button", { name: /Maya/ }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();

      const close = sheet.getByRole("button", { name: "Close player sheet" });
      await expect(close).toBeInViewport();
      await close.click();
      await expect(sheet).toHaveCount(0);
      await expect(page.locator('g[data-client-id="mock-01-maya"]')).toHaveCount(1); // still in the hive
    });
  }

  test("host layout: the host's own sheet has no 'Remove from hive' (it would kick the host out of their own party)", async ({ page }) => {
    await page.goto("/h/BZQ7");
    await page.getByRole("checkbox", { name: "This phone plays music too" }).check();
    const own = page.locator('svg[aria-label^="Hive map"] g[data-client-id]:not([data-client-id^="mock-"])');
    await expect(own).toHaveCount(1, { timeout: 10_000 });
    // long-press opens the sheet
    const box = (await own.locator("circle").first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Remove from hive" })).toHaveCount(0);
  });
});

