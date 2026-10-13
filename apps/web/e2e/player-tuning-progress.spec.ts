/**
 * The guest's tuning screen during a real run, driven through the mock exactly as the server would
 * drive it: this phone is sent how many clicks there are, which slot is its own and when the run
 * starts — and nobody else's id or result (ROOM_STATE is per recipient; see `playerRoomView`).
 *
 * The screen used to count results to show progress. A player is never sent another phone's result,
 * and its own arrives with the report that ends the run, so at a party the bar stayed empty and the
 * line read "Phone 1 of N · about Ns left" for the whole tuning moment. It was invisible here because
 * the only spec for this screen (player-design, "tuning screen") rewrites ROOM_STATE in the page with
 * other phones' ids and results — a message no server sends a player.
 */
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "join.json", seedHostKey: false }); // two seeded phones; this browser is a guest

test("tuning: a guest's progress follows the run, and its own click is ticked off once it has sounded", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Tuned");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Song ready")).toBeVisible({ timeout: 10_000 }); // AUDIO_READY is in: it gets a slot

  const host = await connectAsHost("BZQ7");
  try {
    host.send({ type: "CALIBRATION_START", referenceClientId: "nobody" });
    const bar = page.getByRole("progressbar");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    // Maya, Jon, then this phone: three clicks, 400 ms apart, after a 3 s countdown.
    await expect(bar).toHaveAttribute("aria-valuemax", "3");
    await expect(bar).toHaveAttribute("aria-valuenow", "0"); // nothing has clicked during the countdown
    await expect(page.getByText("Get ready")).toBeVisible();

    // Nobody reports in this run (the reference is not there), so the room stays in `running` for
    // seconds after the last slot: long enough to read where the screen ended up.
    await expect(bar).toHaveAttribute("aria-valuenow", "3", { timeout: 8_000 });
    await expect(page.getByText(/Phone 3 of 3/)).toBeVisible();
    await expect(page.getByText("✓")).toBeVisible(); // "Your click": it was the third
  } finally {
    host.send({ type: "CALIBRATION_CANCEL" });
    host.close();
  }
});
