import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

test("F-screen: /screen shows the code, QR, player count excluding itself, and a read-only map", async ({ page }) => {
  await page.goto("/screen/BZQ7");

  await expect(page.getByText("BZQ7", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

  // party-12.json seeds 12 players (one, Omar, health "bad" so connected: false; the "Players"
  // tile counts only connected -> 11). The screen's own connection (forced plays: true
  // server-side, see PROTOCOL-REQUESTS R-8) must not inflate either count or appear as a
  // phantom 13th dot on its own map -- the map itself keeps disconnected speakers visible, so
  // it still shows all 12 real players.
  await expect(page.getByText("11", { exact: true })).toBeVisible({ timeout: 10_000 });

  const map = page.getByRole("img", { name: "Hive map: 12 player phones" });
  await expect(map).toBeVisible();
  await expect(page.locator('g[data-client-id="mock-01-maya"]')).toBeVisible();
  await expect(page.getByText("Screen (read-only)")).not.toBeVisible();

  // Read-only: dragging a dot must never emit SET_POSITION.
  const sent: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      const parsed = JSON.parse(text);
      sent.push(parsed.type);
    });
  });
  const dot = page.locator('g[data-client-id="mock-01-maya"] circle').first();
  const box = await dot.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 60, box!.y + 40);
  await page.mouse.up();
  expect(sent).not.toContain("SET_POSITION");
  expect(sent).not.toContain("ASSIGN");

  // No host controls anywhere on the page.
  await expect(page.getByRole("button", { name: /start|pause|tune|assign/i })).toHaveCount(0);
});
