import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

/**
 * "This phone plays music too". The engine re-JOINs after every dropped socket with the options it
 * was created with — `plays: false` — and the server takes a host's `plays` from the JOIN, so a Wi-Fi
 * blip used to switch the host's speaker off server-side while the checkbox stayed ticked.
 */
test("host speaker: the toggle survives a dropped connection (the server is told again after the re-JOIN)", async ({ page }) => {
  let drop: (() => void) | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    drop = () => {
      server.close();
      ws.close({ code: 1012, reason: "test: dropped connection" });
    };
  });

  await page.goto("/h/BZQ7");
  const toggle = page.getByRole("checkbox", { name: "This phone plays music too" });
  await expect(toggle).toBeVisible({ timeout: 10_000 });
  // join.json has two players; the host becomes the third speaker on the map.
  await expect(page.getByRole("img", { name: "Hive map: 2 player phones" })).toBeVisible();
  await toggle.check();
  await expect(page.getByRole("img", { name: "Hive map: 3 player phones" })).toBeVisible({ timeout: 5_000 });

  drop!();
  await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("Reconnecting to the hive")).not.toBeVisible({ timeout: 10_000 });

  // Still ticked — and still true: the host is a speaker in the room the server broadcasts.
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("img", { name: "Hive map: 3 player phones" })).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1500); // and it stays that way across the next snapshots
  await expect(page.getByRole("img", { name: "Hive map: 3 player phones" })).toBeVisible();
});
