import { test, expect } from "./fixtures";

test.use({ mockScenario: "calibrating.json" });

test("F7: Host Calibrate rows render waiting/listening/clear", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("clear ✓").first()).toBeVisible();
  await expect(page.getByText("listening…").first()).toBeVisible();
  await expect(page.getByText("waiting").first()).toBeVisible();
});

test("F7: Cancel during a running tuning moment sends CALIBRATION_CANCEL and closes the sheet", async ({ page }) => {
  const sent: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      const parsed = JSON.parse(text);
      sent.push(parsed.type);
    });
  });

  await page.goto("/h/BZQ7");
  await expect(page.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Cancel" }).click();

  expect(sent).toContain("CALIBRATION_CANCEL");
  await expect(page.getByText("Tuning moment")).not.toBeVisible();
});

test.describe("F7: Player Calibrating flashes on a real calibration run", () => {
  test.use({ mockScenario: "join.json" });

  test("host startCalibration -> player flashes", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const hostPage = await hostCtx.newPage();
    const playerPage = await playerCtx.newPage();

    await playerPage.goto("/j/BZQ7");
    await playerPage.getByPlaceholder("Your name").fill("Flash Test");
    await playerPage.getByRole("button", { name: "Tap to join" }).click();
    await expect(playerPage.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });

    await hostPage.goto("/h/BZQ7");
    // "Start anyway" unlocks after a 10s grace period if the real player's AUDIO_READY is slow to land.
    await expect(hostPage.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeEnabled({ timeout: 15_000 });
    await hostPage.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
    await expect(hostPage.getByRole("button", { name: "Tune the hive" })).toBeVisible({ timeout: 10_000 });

    const flashSeen = playerPage.waitForFunction(() => !!document.querySelector('[data-testid="calibration-flash"]'), null, {
      timeout: 8000,
      polling: 20,
    });
    await hostPage.getByRole("button", { name: "Tune the hive" }).click();
    await expect(hostPage.getByText("Tuning moment")).toBeVisible({ timeout: 10_000 });
    await flashSeen;

    await hostCtx.close();
    await playerCtx.close();
  });
});
