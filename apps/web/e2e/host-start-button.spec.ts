import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("host start: between the tap and the music the button reads 'Starting…' and cannot be tapped again", async ({ page }) => {
  const sent: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));

  // PLAY is scheduled ahead of time and the snapshot that confirms it can trail by a rate-limit
  // window; stretch that gap to a second so the state in between is observable.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let slow = false;
    ws.onMessage((m) => {
      if (String(m).includes('"TRANSPORT"')) slow = true;
      server.send(m);
    });
    server.onMessage((m) => {
      if (slow) setTimeout(() => ws.send(m), 1000);
      else ws.send(m);
    });
  });

  await page.goto("/h/BZQ7");
  const start = page.getByRole("button", { name: /Start the hive|Start anyway/ });
  await expect(start).toBeEnabled({ timeout: 15_000 });
  await start.click();

  // It used to keep saying "Start the hive", enabled: a second tap restarted the song for everyone.
  const starting = page.getByRole("button", { name: "Starting…" });
  await expect(starting).toBeVisible();
  await expect(starting).toBeDisabled();
  await starting.click({ force: true }).catch(() => {});

  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  expect(sent.filter((m) => m.includes('"TRANSPORT"')).length).toBe(1);
});
