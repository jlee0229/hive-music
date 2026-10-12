import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

test("host map: on a 320 px phone the map is square and a dragged phone lands under the finger", async ({ page }) => {
  const sent: Array<{ clientId: string; x: number; y: number }> = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const text = String(frame.payload);
      if (text.includes('"SET_POSITION"')) sent.push(JSON.parse(text));
    });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/h/BZQ7");
  const map = page.locator('svg[aria-label^="Hive map"]');
  await expect(map).toBeVisible({ timeout: 10_000 });
  await map.scrollIntoViewIfNeeded();

  // The page is 280 px wide inside its gutters; the map used to be squeezed to 280 wide but stay
  // 350 tall, with the drawing letterboxed inside it.
  const box = (await map.boundingBox())!;
  expect(Math.abs(box.width - box.height)).toBeLessThan(1);

  // Drag Maya to a point 25 % across and 80 % down the *drawing* and compare with what was sent.
  const dot = page.locator('g[data-client-id="mock-01-maya"] circle').first();
  const d = (await dot.boundingBox())!;
  const target = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.8 };
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.waitForTimeout(150); // past the 10 Hz send throttle, so the final position goes out
  await page.mouse.up();

  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const last = sent[sent.length - 1]!;
  expect(last.x).toBeCloseTo(0.25, 1);
  expect(last.y).toBeGreaterThan(0.77);
  expect(last.y).toBeLessThan(0.83);
});
