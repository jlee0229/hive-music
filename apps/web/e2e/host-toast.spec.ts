import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("host toast: a server error is shown in plain words and goes away on its own", async ({ page }) => {
  let inject: ((code: string, message: string) => void) | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    inject = (code, message) => ws.send(JSON.stringify({ type: "ERROR", code, message }));
  });
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });

  inject!("BAD_MESSAGE", "message failed schema validation");
  const toast = page.locator("main").getByRole("alert");
  await expect(toast).toBeVisible();
  await expect(toast).not.toContainText("schema validation");

  // It used to sit above the stage until the page was reloaded.
  await expect(toast).toHaveCount(0, { timeout: 10_000 });
});
