import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

/**
 * A brand-new room has no track; the page picks the first library song itself and shows a
 * "Setting up your hive…" splash until the server confirms it. That splash must not be able to
 * last forever.
 */
test.use({ mockScenario: "join.json" });

/** The mock always pre-seeds a track; a real room starts with none. Hide it until the page sets one. */
async function startWithoutATrack(page: import("@playwright/test").Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let trackSet = false;
    ws.onMessage((m) => {
      if (String(m).includes('"SET_TRACK"')) trackSet = true;
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "ROOM_STATE" && !trackSet) msg.room.track = null;
      ws.send(JSON.stringify(msg));
    });
  });
}

test("host setup: a failed first /tracks request is retried, so the splash ends", async ({ page }) => {
  await startWithoutATrack(page);
  let calls = 0;
  // The page auto-picks whatever the library lists first. Which song that is depends on the
  // checkout: the mock serves every folder under fixtures/tracks, and a developer's machine has
  // more there than the two synthetic tracks — so read it from the answer instead of assuming.
  let firstTitle: string | null = null;
  await page.route(`${MOCK_URL}/tracks`, async (route) => {
    if (++calls <= 2) return route.abort("connectionrefused");
    const res = await route.fetch();
    firstTitle ??= ((await res.json()) as { tracks: Array<{ title: string }> }).tracks[0]!.title;
    return route.fulfill({ response: res });
  });

  await page.goto("/h/BZQ7");
  await expect(page.getByText("Setting up your hive…")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway|Waiting for phones/ })).toBeVisible({ timeout: 15_000 });
  expect(firstTitle).toBeTruthy();
  await expect(page.getByText("Up next:")).toContainText(firstTitle!);
  expect(calls).toBeGreaterThanOrEqual(3);
});

test("host setup: an HTML error page from /tracks (a proxy 502) is treated as a failure, not as an empty library", async ({ page }) => {
  await startWithoutATrack(page);
  let calls = 0;
  await page.route(`${MOCK_URL}/tracks`, (route) =>
    // Two, not one: React's dev-mode double effect fires the request twice and would mask a single failure.
    ++calls <= 2
      ? route.fulfill({ status: 502, contentType: "text/html", headers: { "access-control-allow-origin": "*" }, body: "<html>Bad gateway</html>" })
      : route.continue(),
  );
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway|Waiting for phones/ })).toBeVisible({ timeout: 15_000 });
});
