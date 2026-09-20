import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

// transport already playing: a fresh joiner lands straight on the Playing screen.
test.use({ mockScenario: "party-12.json" });

test("F3: ASSIGN from a host client changes the role and color", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("E2E Playing");
  await page.getByRole("button", { name: "Tap to join" }).click();

  // "YOU ARE" only renders on the Playing screen — waiting for it (not just any font-display
  // span) avoids catching the Ready screen's "Syncing…"/"Synced" text during the brief transition.
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
  const roleLabel = page.locator("span.font-display").last();
  const before = await roleLabel.innerText();

  const clientId = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));
  expect(clientId).toBeTruthy();

  const host = await connectAsHost("BZQ7");
  const nextRole = before.toLowerCase() === "vocals" ? "bass" : "vocals";
  host.send({ type: "ASSIGN", clientId: clientId!, role: nextRole as "bass" | "vocals" });
  await host.waitForRoomState();
  host.close();

  await expect(roleLabel).toHaveText(new RegExp(nextRole, "i"), { timeout: 10_000 });
  const bg = await page.locator("main").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
});

// The player-facing nudge slider is gone (timing is automatic; the host keeps a per-player nudge
// in the player sheet), so the playing screen must NOT render one.
test("F3: the playing screen has no nudge slider", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("E2E Nudge");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel("Sound early or late?")).toHaveCount(0);
});
