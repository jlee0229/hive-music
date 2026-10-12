/** Accessibility basics on the guest screens: what a screen reader is told, and what moves. */
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.describe("state changes are announced", () => {
  test.use({ mockScenario: "join.json" });

  test("joined -> playing -> paused -> removed each reach the live region", async ({ page }) => {
    await page.goto("/j/BZQ7");
    const announcer = page.getByTestId("announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText("");

    await page.getByPlaceholder("Your name").fill("Listener");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(announcer).toHaveText(/You're in/, { timeout: 10_000 });

    const host = await connectAsHost("BZQ7");
    host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    await expect(announcer).toHaveText(/Now playing\. Your part is \w+/, { timeout: 10_000 });

    host.send({ type: "TRANSPORT", action: "PAUSE" });
    await expect(announcer).toHaveText(/paused the music/, { timeout: 10_000 });

    // Being removed interrupts: that screen is itself the alert.
    const clientId = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));
    host.send({ type: "KICK", clientId: clientId! });
    await expect(page.locator("main").getByRole("alert")).toContainText("Removed from hive", { timeout: 10_000 });
    host.close();

    // The region is for assistive tech only; it must not paint anything.
    const box = await announcer.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(1);
  });
});

test.describe("playing screen", () => {
  test.use({ mockScenario: "party-12.json" });

  test("mute is a toggle with a pressed state, and a muted phone says so", async ({ page }) => {
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Muter");
    await page.getByRole("button", { name: "Tap to join" }).click();

    const mute = page.getByRole("button", { name: "Mute my phone" });
    await expect(mute).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
    expect((await mute.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await mute.click();
    const unmute = page.getByRole("button", { name: "Unmute my phone" });
    await expect(unmute).toHaveAttribute("aria-pressed", "true");
    // Silent-because-muted has to look different from silent-because-broken.
    await expect(page.getByText("Muted", { exact: true })).toBeVisible();
    await expect(page.getByTestId("announcer")).toHaveText(/muted/i);

    await unmute.click();
    await expect(page.getByText("Muted", { exact: true })).toHaveCount(0);
  });

  test("prefers-reduced-motion stops the reconnect indicator pulsing", async ({ page, mock }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Still");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

    await mock.stop(); // the server goes away mid-song
    const banner = page.getByText("Reconnecting to the hive…");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    const animation = await banner.locator("span").first().evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe("none");
  });
});
