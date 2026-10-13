/**
 * PARTY-01 — the server restarts and the host has not brought the hive back yet. A guest who was
 * in the hive is told NO_ROOM when it reconnects. That used to be the end: "Hive not found", the
 * engine torn down, no way back short of scanning the QR again — even though the host restored the
 * room under the same code half a minute later.
 */
import { test, expect } from "./fixtures";

// chaos: every socket dropped at 12 s, and every JOIN answered NO_ROOM until 20 s (the host returning).
test.use({ mockScenario: "room-lost.json", seedHostKey: false });
test.setTimeout(90_000);

test("a guest who was in the hive waits for the host instead of being thrown out, and is let back in", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Staying");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
  const clientIdBefore = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));

  // The room is gone: the waiting screen, with the line a guest already knows.
  await expect(page.getByText("Waiting for the host to come back")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Hive not found")).toHaveCount(0);
  await expect(page.getByText("YOU ARE")).toHaveCount(0); // not the playing screen of a room that is not there
  // It is the ordinary waiting screen: the sponsor slot and the creators line are on it, and it does not scroll.
  await expect(page.getByText("Sponsored")).toBeVisible();
  await expect(page.getByText("Creators: Frank Lucci & Jaeho Lee")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  await expect(page.getByTestId("announcer")).toHaveText("The host has gone for now.");

  // The host is back (the mock's room returns at 20 s): the page's own retry gets the guest in again.
  let thrownOut = false;
  const watch = setInterval(() => {
    void page
      .getByText("Hive not found")
      .count()
      .then((n) => {
        if (n > 0) thrownOut = true;
      })
      .catch(() => {});
  }, 250);
  try {
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 45_000 });
  } finally {
    clearInterval(watch);
  }
  expect(thrownOut, "never shown 'Hive not found' while waiting").toBe(false);
  await expect(page.getByText("Waiting for the host to come back")).toHaveCount(0);
  await expect(page.getByText("Reconnecting to the hive")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"))).toBe(clientIdBefore); // the same phone, the same seat
  expect(errors).toEqual([]);
});

test("a guest who never got in — a wrong code — is still told at once", async ({ page }) => {
  // The lookup the page makes on arrival fails (offline for a moment), so the join form is shown
  // and the answer has to come from the JOIN itself.
  await page.route("**/rooms/NOPE", (route) => route.abort());
  await page.goto("/j/NOPE");
  await page.getByPlaceholder("Your name").fill("Lost");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Hive not found")).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("link", { name: "Back home" })).toBeVisible();
  await expect(page.getByText("Waiting for the host to come back")).toHaveCount(0);
});
