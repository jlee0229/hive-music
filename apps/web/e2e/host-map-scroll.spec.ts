import { devices, type CDPSession, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const { defaultBrowserType: _unused, ...pixel } = devices["Pixel 7"] as (typeof devices)[string] & { defaultBrowserType?: string };

test.use({ ...pixel, mockScenario: "join.json" });

/** A finger swipe upwards (the gesture that scrolls a page down), as real touch input. Returns how far the page scrolled. */
async function swipeUp(page: Page, cdp: CDPSession, x: number, y: number, distance = 150): Promise<number> {
  const before = await page.evaluate(() => window.scrollY);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - (distance * i) / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  return (await page.evaluate(() => window.scrollY)) - before;
}

test("host map (touch): a swipe that starts on the map's background scrolls the page; one that starts on a phone drags the phone", async ({ page, context }) => {
  const sent: Array<{ clientId: string; y: number }> = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      const text = String(f.payload);
      if (text.includes('"SET_POSITION"')) sent.push(JSON.parse(text));
    }),
  );
  await page.goto("/h/BZQ7");
  const map = page.locator('svg[aria-label^="Hive map"]');
  await expect(map.locator("g[data-client-id]")).toHaveCount(2, { timeout: 10_000 });
  const cdp = await context.newCDPSession(page);

  // The map is a screen-wide square in the middle of the stage. With touch-action: none on all of it
  // a thumb that started there could not scroll at all (0 px, against 135 px anywhere else).
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await map.boundingBox())!;
  const scrolled = await swipeUp(page, cdp, box.x + box.width - 20, box.y + 40); // top-right: no phone there
  expect(scrolled).toBeGreaterThan(60);
  expect(sent).toEqual([]);

  // A phone is still something you drag: the page stays put and the phone moves.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const dot = (await map.locator('g[data-client-id="mock-02-jon"] circle').first().boundingBox())!;
  const onDot = await swipeUp(page, cdp, dot.x + dot.width / 2, dot.y + dot.height / 2, 60);
  expect(onDot).toBe(0);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent.every((m) => m.clientId === "mock-02-jon")).toBe(true);
});
