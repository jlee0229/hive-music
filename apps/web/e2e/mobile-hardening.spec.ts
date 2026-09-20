import { devices } from "@playwright/test";
import { test, expect } from "./fixtures";

// devices[...] includes `defaultBrowserType`, which forces a new worker and can't be set inside
// describe(); we only want the context-level bits (viewport/UA/touch) under the existing chromium project.
function mobileContext(name: keyof typeof devices) {
  const { defaultBrowserType: _defaultBrowserType, ...rest } = devices[name] as typeof devices extends Record<string, infer D>
    ? D & { defaultBrowserType?: string }
    : never;
  return rest;
}

test.use({ mockScenario: "party-12.json" });

test.describe("mobile hardening: meta tags + CSS", () => {
  test.use({ ...mobileContext("iPhone 15") });

  test("viewport meta disables pinch/double-tap zoom and covers the safe area", async ({ page }) => {
    await page.goto("/j/BZQ7");
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).toContain("viewport-fit=cover");
    expect(content).toMatch(/maximum-scale=1(\.0)?/);
    expect(content).toMatch(/user-scalable=(no|0)/);
  });

  test("html/body disable pull-to-refresh and double-tap zoom", async ({ page }) => {
    await page.goto("/j/BZQ7");
    const overscroll = await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehavior);
    expect(overscroll).toBe("none");
    const touchAction = await page.evaluate(() => getComputedStyle(document.body).touchAction);
    expect(touchAction).toBe("manipulation");
  });

  test("Player Playing screen carries safe-area padding and locks gestures", async ({ page }) => {
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Mobile Test");
    await page.getByRole("button", { name: "Tap to join" }).click();
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

    const style = await page.locator("main").first().getAttribute("style");
    expect(style).toContain("env(safe-area-inset-top");
    expect(style).toContain("env(safe-area-inset-bottom");
    expect(style).toContain("touch-action: manipulation");
    expect(style).toContain("overscroll-behavior: none");
  });

  test("no text-selection callout on the Hive Map", async ({ page }) => {
    // The player nudge slider (the other .no-callout) is gone, so the map on the host stage is
    // the element under test now; party-12 has the transport playing, landing hosts on the stage.
    await page.goto("/h/BZQ7");
    await expect(page.locator('svg[aria-label^="Hive map"]')).toBeVisible({ timeout: 10_000 });
    const userSelect = await page.evaluate(() => {
      const el = document.querySelector(".no-callout");
      return el ? getComputedStyle(el).userSelect : null;
    });
    expect(userSelect).toBe("none");
  });

});

test.describe("mobile hardening: whole-screen tap target", () => {
  // party-12.json (this file's default scenario) already has transport playing, so a fresh
  // join skips Ready entirely; join.json (transport stopped) lands on the screen that shows
  // "Synced", which is what this test needs to assert on.
  test.use({ ...mobileContext("iPhone 15"), mockScenario: "join.json" });

  test("the whole Join screen is a tap target, not just the button", async ({ page }) => {
    await page.goto("/j/BZQ7");
    await page.getByPlaceholder("Your name").fill("Whole Screen Test");
    // tap far from the button, near the top of the screen
    await page.locator('span:text("Joining a hive")').click();
    await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("mobile hardening: Hive Map drag under real touch events", () => {
  test.use({ ...mobileContext("Pixel 7") });

  test("dragging a dot with CDP touch input still emits normalized SET_POSITION", async ({ page, context }) => {
    const sent: Array<{ type: string; x: number; y: number }> = [];
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
        if (text.includes('"SET_POSITION"')) sent.push(JSON.parse(text));
      });
    });

    await page.goto("/h/BZQ7");
    const dot = page.locator('g[data-client-id="mock-01-maya"]');
    await expect(dot).toBeVisible({ timeout: 10_000 });
    const box = await dot.locator("circle").first().boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;

    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 50, y: y + 40 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect.poll(() => sent.length, { timeout: 3000 }).toBeGreaterThan(0);
    for (const msg of sent) {
      expect(msg.x).toBeGreaterThanOrEqual(0);
      expect(msg.x).toBeLessThanOrEqual(1);
      expect(msg.y).toBeGreaterThanOrEqual(0);
      expect(msg.y).toBeLessThanOrEqual(1);
    }
  });
});
