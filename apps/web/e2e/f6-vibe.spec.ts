import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("F6: submit posts to /rooms/BZQ7/vibe, the strip shows 3 scenes, and the highlight moves as time advances", async ({ page }) => {
  const vibePost = page.waitForResponse((res) => res.url().includes("/rooms/BZQ7/vibe") && res.request().method() === "POST");

  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Describe the vibe").fill("calm then explode at the drop");
  await page.getByRole("button", { name: "Direct" }).click();
  const res = await vibePost;
  expect(res.ok()).toBeTruthy();

  const scenes = page.locator('[data-testid="scene-strip"] > div');
  await expect(scenes).toHaveCount(3, { timeout: 10_000 });
  await expect(scenes.nth(0)).toHaveAttribute("data-active", "true");

  // seek into the second scene's window (mock plan: 0 / dur*0.5=30 / dur*0.75=45, duration=60)
  const seekBar = page.getByRole("slider", { name: "Seek" });
  const box = await seekBar.boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.55, box!.y + box!.height / 2);
  await expect(scenes.nth(1)).toHaveAttribute("data-active", "true", { timeout: 5000 });

  await page.mouse.click(box!.x + box!.width * 0.9, box!.y + box!.height / 2);
  await expect(scenes.nth(2)).toHaveAttribute("data-active", "true", { timeout: 5000 });
});

test("F6: a manual mode chip clears the plan", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await page.getByLabel("Describe the vibe").fill("calm then explode at the drop");
  await page.getByRole("button", { name: "Direct" }).click();
  await expect(page.locator('[data-testid="scene-strip"] > div')).toHaveCount(3, { timeout: 10_000 });

  await page.getByRole("button", { name: "Wave", exact: true }).click();
  await expect(page.locator('[data-testid="scene-strip"]')).toHaveCount(0, { timeout: 5000 });
});
