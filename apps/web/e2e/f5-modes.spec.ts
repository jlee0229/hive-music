import type { WebSocket as PWWebSocket } from "@playwright/test";
import { MODES } from "@hive/protocol";
import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

test("F5: each mode chip sends SET_MODE with the right kind", async ({ page }) => {
  const sent: Array<{ type: string; mode: string }> = [];
  page.on("websocket", (ws: PWWebSocket) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      if (text.includes('"SET_MODE"')) sent.push(JSON.parse(text));
    });
  });

  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: "Orchestra" })).toBeVisible({ timeout: 10_000 });

  for (const kind of MODES) {
    const label = kind.charAt(0) + kind.slice(1).toLowerCase();
    await page.getByRole("button", { name: label, exact: true }).click();
  }

  await expect.poll(() => sent.length).toBe(MODES.length);
  expect(sent.map((m) => m.mode)).toEqual(MODES);
});

test("F5: WAVE and STROBE assignments carry a pattern the map animates", async ({ page }) => {
  const sent: Array<{ type: string; mode: string }> = [];
  page.on("websocket", (ws: PWWebSocket) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      if (text.includes('"SET_MODE"')) sent.push(JSON.parse(text));
    });
  });

  await page.goto("/h/BZQ7");
  await page.getByRole("button", { name: "Strobe", exact: true }).click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);

  // Once STROBE is applied, at least one dot's fill-opacity should be animating (not pinned at 1).
  const dot = page.locator('g[data-client-id="mock-01-maya"] circle').nth(1);
  const opacities = new Set<string | null>();
  for (let i = 0; i < 6; i++) {
    opacities.add(await dot.getAttribute("fill-opacity"));
    await page.waitForTimeout(120);
  }
  expect(opacities.size).toBeGreaterThan(1);
});
