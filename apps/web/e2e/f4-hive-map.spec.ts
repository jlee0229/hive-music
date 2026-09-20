import type { WebSocket as PWWebSocket } from "@playwright/test";
import { ROLE_COLORS } from "@hive/protocol";
import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

function captureFrames(page: import("@playwright/test").Page, type: string, sink: unknown[]) {
  page.on("websocket", (ws: PWWebSocket) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      if (text.includes(`"${type}"`)) sink.push(JSON.parse(text));
    });
  });
}

test("F4: 12 dots render", async ({ page }) => {
  await page.goto("/h/BZQ7");
  const dots = page.locator('svg[aria-label^="Hive map"] g[data-client-id]');
  await expect(dots).toHaveCount(12, { timeout: 10_000 });
});

test("F4: dragging a dot emits SET_POSITION with 0 <= x,y <= 1", async ({ page }) => {
  const sent: Array<{ type: string; clientId: string; x: number; y: number }> = [];
  captureFrames(page, "SET_POSITION", sent);

  await page.goto("/h/BZQ7");
  const dot = page.locator('g[data-client-id="mock-01-maya"]');
  await expect(dot).toBeVisible({ timeout: 10_000 });
  const circle = dot.locator("circle").first();
  const box = await circle.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => sent.length, { timeout: 3000 }).toBeGreaterThan(0);
  for (const msg of sent) {
    expect(msg.x).toBeGreaterThanOrEqual(0);
    expect(msg.x).toBeLessThanOrEqual(1);
    expect(msg.y).toBeGreaterThanOrEqual(0);
    expect(msg.y).toBeLessThanOrEqual(1);
    expect(msg.clientId).toBe("mock-01-maya");
  }
});

test("F4: tapping a dot cycles its pinned role", async ({ page }) => {
  const sent: Array<{ type: string; clientId: string; role: string | null }> = [];
  captureFrames(page, "ASSIGN", sent);

  await page.goto("/h/BZQ7");
  const dot = page.locator('g[data-client-id="mock-01-maya"]');
  await expect(dot).toBeVisible({ timeout: 10_000 });
  await dot.click();

  await expect.poll(() => sent.length, { timeout: 3000 }).toBeGreaterThan(0);
  expect(sent[0]!.clientId).toBe("mock-01-maya");
  expect(["drums", "bass", "vocals", "other", null]).toContain(sent[0]!.role);
});

test("F4: legend entries equal Object.keys(ROLE_COLORS)", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.locator('svg[aria-label^="Hive map"]')).toBeVisible({ timeout: 10_000 });
  for (const role of Object.keys(ROLE_COLORS)) {
    await expect(page.getByText(role, { exact: true })).toBeVisible();
  }
});
