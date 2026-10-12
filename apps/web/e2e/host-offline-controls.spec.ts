import { test, expect } from "./fixtures";

test.use({ mockScenario: "party-12.json" });

/**
 * A command sent while the socket is down is dropped by the engine, not queued. The stage used to
 * look fully alive during a Wi-Fi blip: the host tapped a mode or Pause and nothing happened, with
 * nothing to say why. While not connected the controls are off; they come back with the connection.
 */
test("host offline: while the connection is down the controls are disabled, and they return when it does", async ({ page }) => {
  let down = false;
  let drop: (() => void) | null = null;
  const sentWhileDown: string[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (down) {
      // The server cannot be reached: every attempt ends at once, the engine keeps backing off.
      void ws.close({ code: 1006, reason: "test: unreachable" });
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (down) sentWhileDown.push(String(m));
      server.send(m);
    });
    drop = () => {
      server.close();
      void ws.close({ code: 1012, reason: "test: dropped connection" });
    };
  });

  await page.goto("/h/BZQ7");
  const controls = page.getByTestId("host-controls");
  const pause = page.getByRole("button", { name: "Pause" });
  const wave = page.getByRole("button", { name: "Wave", exact: true });
  await expect(pause).toBeEnabled({ timeout: 10_000 });
  await expect(controls).toHaveJSProperty("disabled", false);

  // A drawer that is open when the connection goes folds away: its buttons could not answer either.
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await expect(page.getByPlaceholder("Search the library")).toBeVisible();

  down = true;
  drop!();
  await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByPlaceholder("Search the library")).toHaveCount(0);
  await expect(controls).toHaveJSProperty("disabled", true);
  for (const control of [pause, wave, page.getByRole("button", { name: "Tune the hive" }), page.getByRole("checkbox", { name: "This phone plays music too" })]) {
    await expect(control).toBeDisabled();
  }
  // Still usable: leaving, and the join link (neither needs the socket).
  await expect(page.getByRole("button", { name: "Exit the hive" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeEnabled();

  await wave.click({ force: true, timeout: 2_000 }).catch(() => {});
  await page.locator('g[data-client-id="mock-01-maya"]').click({ force: true, timeout: 2_000 }).catch(() => {});

  down = false;
  await expect(page.getByText("Reconnecting to the hive")).toHaveCount(0, { timeout: 15_000 });
  await expect(controls).toHaveJSProperty("disabled", false);
  await expect(pause).toBeEnabled();
  // Nothing tapped while it was down went out, then or afterwards: the mode is what it was.
  expect(sentWhileDown.filter((m) => /SET_MODE|ASSIGN|TRANSPORT/.test(m))).toEqual([]);
  await expect(page.getByRole("button", { name: "Orchestra", exact: true })).toHaveAttribute("aria-pressed", "true");

  await wave.click();
  await expect(wave).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 });
});
