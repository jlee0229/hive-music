import { test, expect } from "./fixtures";

/**
 * What the stage says about tuning. (The decisions behind Start itself — tune first or play, the
 * double-tap guard, the failsafe — are unit-tested in lib/hive/start-flow.test.ts: they only run on
 * the real engine, which this suite's stub engine replaces.)
 */
test.use({ mockScenario: "join.json" });

test("host stage: says nothing about tuning when no tuning has run (it used to claim 'tuned automatically at start')", async ({ page }) => {
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/tuned automatically/i)).toHaveCount(0);
  await expect(page.getByText(/Tuning (needs|didn)/)).toHaveCount(0);

  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  // The stub engine never tunes, so after Start the claim would still be false.
  await expect(page.getByText(/tuned automatically/i)).toHaveCount(0);
});

test("host stage: a failed tuning left in the room does not greet a reloading host with a full-screen 'Couldn't finish'", async ({ page }) => {
  // `failed` stays in room.calibration until the next run. Rewrite the snapshots to carry it.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "ROOM_STATE") msg.room.calibration = { ...msg.room.calibration, state: "failed" };
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto("/h/BZQ7");

  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Tuning moment")).toHaveCount(0);
  // One short, true line instead.
  await expect(page.getByText("Tuning didn’t finish — try again when the room is quiet.")).toBeVisible();
});
