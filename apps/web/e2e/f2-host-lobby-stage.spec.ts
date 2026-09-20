import jsQR from "jsqr";
import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("F2: library search filters the list", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });

  await page.getByPlaceholder("Search the library").fill("nonexistent-track-xyz");
  await expect(page.getByText("Synthetic 60")).toHaveCount(0);

  await page.getByPlaceholder("Search the library").fill("synthetic");
  await expect(page.getByText("Synthetic 60")).toBeVisible();
});

test("F2: the QR decodes to the join URL", async ({ page }) => {
  await page.goto("/h/BZQ7");
  const canvas = page.locator('canvas[aria-label^="QR code"]');
  await expect(canvas).toBeVisible();

  const { data, width, height } = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d")!;
    const img = ctx.getImageData(0, 0, el.width, el.height);
    return { data: Array.from(img.data), width: el.width, height: el.height };
  });
  const decoded = jsQR(Uint8ClampedArray.from(data), width, height);
  expect(decoded?.data).toContain("/j/BZQ7");
});

test("F2: Start sends TRANSPORT PLAY and the transport bar starts moving", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click({ trial: false });

  // Stage renders once transport leaves "stopped"; the pause icon replaces play, and the clock advances.
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  const readClock = () => page.locator("span.font-mono", { hasText: /\/ /}).first().innerText();
  const t1 = await readClock();
  await page.waitForTimeout(2500);
  const t2 = await readClock();
  expect(t2).not.toBe(t1);
});

test("F2: Stage has a Join QR code link to /qr/[code] and a copy button for the join URL", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/h/BZQ7");
  await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });

  const link = page.getByRole("link", { name: "Join QR code" });
  await expect(link).toHaveAttribute("href", "/qr/BZQ7");

  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain("/j/BZQ7");
});
