/** /qr/<code>: the page the host holds up or throws on a TV. It has one job — be scannable. */
import jsQR from "jsqr";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

/** Reads the QR back out of the canvas, the way a phone camera would have to. */
async function decodeQr(page: Page): Promise<string | null> {
  const canvas = page.getByRole("img", { name: /QR code/ });
  await expect(canvas).toBeVisible();
  // toCanvas runs in an effect after the join URL is known; wait until the code that is drawn is
  // the absolute one.
  let decoded: string | null = null;
  await expect
    .poll(async () => {
      const { data, width, height } = await canvas.evaluate((el: HTMLCanvasElement) => {
        // A TV-sized canvas is millions of pixels; hand back at most 400 px a side.
        const side = Math.min(el.width, 400);
        const small = document.createElement("canvas");
        small.width = small.height = side;
        const ctx = small.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(el, 0, 0, side, side);
        const image = ctx.getImageData(0, 0, side, side);
        return { data: Array.from(image.data), width: image.width, height: image.height };
      });
      decoded = jsQR(Uint8ClampedArray.from(data), width, height)?.data ?? null;
      return decoded;
    })
    .toMatch(/^https?:\/\//);
  return decoded;
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 667, height: 375 },
  { width: 1920, height: 1080 },
]) {
  test(`${viewport.width}x${viewport.height}: the QR decodes to the join link and the whole page fits without scrolling`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    await page.goto("/qr/BZQ7");

    expect(await decodeQr(page)).toBe(`${baseURL}/j/BZQ7`);

    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x, "page scrolls sideways").toBeLessThanOrEqual(0);
    expect(overflow.y, "page scrolls vertically").toBeLessThanOrEqual(0);
    // The white card is the QR's quiet zone; it has to be on screen in full.
    await expect(page.getByRole("img", { name: /QR code/ })).toBeInViewport({ ratio: 1 });
  });
}

test("a very short window still gets a QR that scans", async ({ page, baseURL }) => {
  // Split-screen, or a landscape phone with browser chrome out: under 200 px of height.
  await page.setViewportSize({ width: 400, height: 180 });
  await page.goto("/qr/BZQ7");
  expect(await decodeQr(page)).toBe(`${baseURL}/j/BZQ7`);
});

test("a code with no hive behind it shows that, not a QR for a dead link", async ({ page }) => {
  await page.goto("/qr/ZZZZ");
  await expect(page.getByRole("heading", { name: "Hive not found" })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("img", { name: /QR code/ })).toHaveCount(0);
});
