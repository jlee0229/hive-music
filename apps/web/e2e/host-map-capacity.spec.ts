import path from "node:path";
import { test, expect } from "./fixtures";

/**
 * A real party is 25-40 phones, none of them dragged into place. The auto-layout has to hold all of
 * them without stacking dots on top of each other (it used to run out of free slots near 19 phones
 * and drop every later arrival on the exact centre of the map).
 */
test.use({ mockScenario: "party-40.json" });

const SHOTS = process.env.HOST_UI_SHOTS; // optional: directory to drop audit screenshots into

test("host map: 40 unplaced phones all get their own spot, inside the map", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/h/BZQ7");
  const dots = page.locator('svg[aria-label^="Hive map"] g[data-client-id]');
  await expect(dots).toHaveCount(40, { timeout: 10_000 });

  const geometry = await page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label^="Hive map"]')!;
    const box = svg.getBoundingClientRect();
    return {
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      dots: [...svg.querySelectorAll("g[data-client-id]")].map((g) => {
        // The first circle is the health ring — the outline of the dot, and the thing that must not
        // collide with a neighbour.
        const r = g.querySelector("circle")!.getBoundingClientRect();
        return { id: g.getAttribute("data-client-id")!, cx: r.x + r.width / 2, cy: r.y + r.height / 2, r: r.width / 2 };
      }),
    };
  });

  let overlapping = 0;
  for (let i = 0; i < geometry.dots.length; i++) {
    for (let j = i + 1; j < geometry.dots.length; j++) {
      const a = geometry.dots[i]!;
      const b = geometry.dots[j]!;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r) overlapping++;
    }
  }
  if (SHOTS) await page.locator('svg[aria-label^="Hive map"]').screenshot({ path: path.join(SHOTS, "map-40-players.png") });
  expect(overlapping, "pairs of dots drawn on top of each other").toBe(0);

  for (const d of geometry.dots) {
    expect(d.cx - d.r, `${d.id} left edge`).toBeGreaterThanOrEqual(geometry.box.x);
    expect(d.cx + d.r, `${d.id} right edge`).toBeLessThanOrEqual(geometry.box.x + geometry.box.w);
    expect(d.cy - d.r, `${d.id} top edge`).toBeGreaterThanOrEqual(geometry.box.y);
    expect(d.cy + d.r, `${d.id} bottom edge`).toBeLessThanOrEqual(geometry.box.y + geometry.box.h);
  }
});
