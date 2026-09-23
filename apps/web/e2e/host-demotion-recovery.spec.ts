import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("F2: a stale hostKey demotes then self-recovers to host without looping", async ({ page }) => {
  // Simulates a room that was re-created server-side (a restart, an idle timeout) under a fresh
  // hostKey while this tab still holds the old one: the JOIN forced to kind: player, plays: true
  // (server can't tell this phone apart from a real player without a matching key).
  await page.addInitScript((code) => {
    localStorage.setItem(`hive:hostKey:${code}`, "stale-key-from-before-the-restart");
  }, "BZQ7");

  await page.goto("/h/BZQ7");

  // Recovers: reaches the normal host stage (POST /rooms re-claims the room's real key), not
  // stuck showing a player-side view or the "lost host control" error.
  await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Join QR code" })).toBeVisible();

  const storedKey = await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"));
  expect(storedKey).not.toBe("stale-key-from-before-the-restart");

  // Fully functional as host afterwards -- not just visually present.
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
});
