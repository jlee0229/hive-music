import { devices } from "@playwright/test";
import { test, expect } from "./fixtures";

const { defaultBrowserType: _unused, ...pixel } = devices["Pixel 7"] as (typeof devices)[string] & { defaultBrowserType?: string };

test.use({ ...pixel, mockScenario: "party-12.json" });

test("host map (touch): a tap that wobbles 9 px is still a tap — it changes the part, it does not 'place' the phone", async ({ page, context }) => {
  const sent: Array<{ type: string }> = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      if (text.includes('"SET_POSITION"') || text.includes('"ASSIGN"')) sent.push(JSON.parse(text));
    });
  });

  await page.goto("/h/BZQ7");
  const dot = page.locator('g[data-client-id="mock-01-maya"]');
  await expect(dot).toBeVisible({ timeout: 10_000 });
  await dot.scrollIntoViewIfNeeded();
  const box = (await dot.locator("circle").first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // A real fingertip: down, a few pixels of drift while it is pressed, up. (6 px used to be enough
  // to turn the tap into a drag, which silently converted an auto-placed phone into a hand-placed one.)
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 6, y: y + 4 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 8, y: y + 5 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  await expect.poll(() => sent.length, { timeout: 3000 }).toBeGreaterThan(0);
  expect(sent.map((m) => m.type)).toEqual(["ASSIGN"]);
});
