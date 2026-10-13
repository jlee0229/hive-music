import path from "node:path";
import type { Page } from "@playwright/test";
import { speakerLayout, type RoomState } from "@hive/protocol";
import { test, expect } from "./fixtures";

/**
 * The Hive Map draws phones exactly where the planner believes they are: `speakerLayout(room)` from
 * @hive/protocol, the function WAVE's sweep and STEREO's sides are computed from. (The map used to
 * invent its own arrangement, so the host watched dots in one place while the sweep crossed another.)
 */
const SHOTS = process.env.HOST_UI_SHOTS; // optional: directory for audit screenshots
const TAG = process.env.HOST_UI_TAG ?? "";

/** Passes snapshots through, optionally cut down to the first `keep` scripted players, and remembers the last one. */
async function watchRoom(page: Page, keep?: number): Promise<{ room: () => RoomState }> {
  let last: RoomState | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "ROOM_STATE") {
        if (keep !== undefined) {
          const scripted = Object.keys(msg.room.clients).filter((id) => id.startsWith("mock-")).sort();
          for (const id of scripted.slice(keep)) delete msg.room.clients[id];
        }
        last = msg.room as RoomState;
      }
      ws.send(JSON.stringify(msg));
    });
  });
  return { room: () => last! };
}

async function drawnDots(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label^="Hive map"]')!;
    const box = svg.getBoundingClientRect();
    return {
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      dots: [...svg.querySelectorAll("g[data-client-id]")].map((g) => {
        // The first circle is the health ring — the outline of the dot.
        const r = g.querySelector("circle")!.getBoundingClientRect();
        return { id: g.getAttribute("data-client-id")!, cx: r.x + r.width / 2, cy: r.y + r.height / 2, r: r.width / 2 };
      }),
    };
  });
}

test.describe("auto-placed phones", () => {
  test.use({ mockScenario: "party-60.json" });

  for (const n of [1, 3, 12, 40, 60]) {
    test(`host map: ${n} unplaced phone${n === 1 ? "" : "s"} — drawn where the planner puts them, none overlapping, none clipped`, async ({ page }) => {
      const watch = await watchRoom(page, n);
      await page.setViewportSize({ width: 393, height: 852 });
      await page.goto("/h/BZQ7");
      const map = page.locator('svg[aria-label^="Hive map"]');
      await expect(map.locator("g[data-client-id]")).toHaveCount(n, { timeout: 10_000 });
      await map.scrollIntoViewIfNeeded();

      const { box, dots } = await drawnDots(page);
      if (SHOTS) await map.screenshot({ path: path.join(SHOTS, `map-layout-${String(n).padStart(2, "0")}${TAG}.png`) });

      const layout = speakerLayout(watch.room());
      for (const d of dots) {
        const p = layout.positions[d.id]!;
        expect(Math.abs(d.cx - (box.x + p.x * box.w)), `${d.id} x`).toBeLessThan(1.5);
        expect(Math.abs(d.cy - (box.y + p.y * box.h)), `${d.id} y`).toBeLessThan(1.5);
        expect(d.cx - d.r, `${d.id} left edge`).toBeGreaterThanOrEqual(box.x);
        expect(d.cx + d.r, `${d.id} right edge`).toBeLessThanOrEqual(box.x + box.w);
        expect(d.cy - d.r, `${d.id} top edge`).toBeGreaterThanOrEqual(box.y);
        expect(d.cy + d.r, `${d.id} bottom edge`).toBeLessThanOrEqual(box.y + box.h);
      }
      let overlapping = 0;
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          if (Math.hypot(dots[i]!.cx - dots[j]!.cx, dots[i]!.cy - dots[j]!.cy) < dots[i]!.r + dots[j]!.r) overlapping++;
        }
      }
      expect(overlapping, "pairs of dots drawn on top of each other").toBe(0);

      // Names are drawn while they fit between neighbours (up to 19 phones), and not at all after that.
      const labels = await map.locator("g[data-client-id] text").count();
      expect(labels).toBe(n <= 19 ? n : 0);
    });
  }
});

test.describe("the sweep follows the map", () => {
  test.use({ mockScenario: "party-12.json" });

  test("host map: in Wave, an undragged phone's delay comes from where it is drawn, and dragging it moves the delay", async ({ page }) => {
    const watch = await watchRoom(page);
    await page.goto("/h/BZQ7");
    const map = page.locator('svg[aria-label^="Hive map"]');
    const kai = map.locator('g[data-client-id="mock-12-kai"]'); // the one phone in party-12 nobody placed
    await expect(kai).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Wave", exact: true }).click();
    await expect.poll(() => watch.room().mode.kind).toBe("WAVE");
    await expect.poll(() => watch.room().clients["mock-12-kai"]!.assignment?.label).toBe("wave");

    // Not dragged: the server has no position for it, the map and the planner share the auto slot.
    const before = watch.room();
    expect(before.clients["mock-12-kai"]!.position).toBeNull();
    const slot = speakerLayout(before).positions["mock-12-kai"]!;
    await map.scrollIntoViewIfNeeded();
    const g1 = await drawnDots(page);
    const drawn = g1.dots.find((d) => d.id === "mock-12-kai")!;
    expect(Math.abs((drawn.cx - g1.box.x) / g1.box.w - slot.x)).toBeLessThan(0.005);
    const span = 240; // WAVE_DEFAULT_SPAN_MS
    expect(before.clients["mock-12-kai"]!.assignment!.delayMs).toBe(Math.round(span * slot.x));

    // Dragged to the right edge: a real position is written, and the delay follows it.
    const target = { x: g1.box.x + g1.box.w * 0.9, y: g1.box.y + g1.box.h * 0.5 };
    await page.mouse.move(drawn.cx, drawn.cy);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await page.waitForTimeout(150); // past the 10 Hz send throttle, so the final position goes out
    await page.mouse.up();
    await expect.poll(() => watch.room().clients["mock-12-kai"]!.position?.x ?? 0).toBeGreaterThan(0.88);
    const after = watch.room();
    const x = after.clients["mock-12-kai"]!.position!.x;
    expect(after.clients["mock-12-kai"]!.assignment!.delayMs).toBe(Math.round(span * x));
    expect(after.clients["mock-12-kai"]!.assignment!.delayMs).toBeGreaterThan(205);
  });
});
