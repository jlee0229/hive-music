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

test("F0: /diag connects to the code that was typed, not to a built-in default", async ({ page }) => {
  // The mock's only room is BZQ7. A page that ignores the box and joins its default code would
  // report "open" here; one that honours the box is told there is no such hive.
  await page.goto("/diag");
  await page.getByLabel("Room code").fill("zzzz");
  await expect(page.getByLabel("Room code")).toHaveValue("ZZZZ");
  await page.getByRole("button", { name: "Tap to connect" }).click();

  await expect(page.locator("main").getByRole("alert")).toContainText("ZZZZ", { timeout: 10_000 });
  await expect(page.getByText("clientId")).toHaveCount(0);

  // Correcting the code works without a reload.
  await page.getByLabel("Room code").fill("BZQ7");
  await page.getByRole("button", { name: "Tap to connect" }).click();
  await expect(page.getByText("open", { exact: true })).toBeVisible({ timeout: 10_000 });
  const codeRow = page.locator("div").filter({ hasText: /^room\.code/ }).last();
  await expect(codeRow).toContainText("BZQ7");
});

test("F0: Copy report puts a JSON diagnostic snapshot on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/diag");
  await page.getByLabel("Room code").fill("BZQ7");
  await page.getByRole("button", { name: "Tap to connect" }).click();
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Copy report" }).click();
  await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  const report = JSON.parse(clipboardText);
  expect(report).toMatchObject({
    browserFamily: expect.any(String),
    protocolVersion: expect.any(Number),
    unlockState: "ready",
  });
  expect(typeof report.rttMs === "number" || report.rttMs === null).toBe(true);
});
