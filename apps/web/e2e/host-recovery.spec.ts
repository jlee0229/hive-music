import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

/**
 * Every way the host page can fail to become the host must end on a screen that says what happened
 * and has a way out — never a spinner that spins forever, never a dead stage.
 */
test.use({ mockScenario: "join.json" });

const CORS = { "access-control-allow-origin": "*" };

test("host recovery: the hive is gone (NO_ROOM) -> 'This hive has ended', a way to host a new one, and the dead key is dropped", async ({ page }) => {
  // What a host sees after the server restarted (rooms live in memory) and they reload: the stored
  // key is for a room that no longer exists, so the JOIN is answered with ERROR NO_ROOM.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) localStorage.setItem("hive:hostKey:NOPE", "key-of-a-room-that-is-gone");
    sessionStorage.setItem("seeded", "1");
  });
  await page.goto("/h/NOPE");

  await expect(page.getByRole("heading", { name: "This hive has ended" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Host a new hive" })).toHaveAttribute("href", "/");
  await expect(page.getByText("Setting up your hive")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:NOPE"))).toBeNull();
});

test("host recovery: no key and the server says the code is unknown (400) -> 'This hive has ended', not 'is the server running?'", async ({ page }) => {
  await page.route(`${MOCK_URL}/rooms`, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "unknown room code" }) }),
  );
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("heading", { name: "This hive has ended" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Host a new hive" })).toHaveAttribute("href", "/");
});

test("host recovery: no key and the server will not hand one out -> 'hosted on another phone', with a way to join it", async ({ page }) => {
  // The shape of the host-key redesign is not final; both a refusal and a key-less 2xx must read the same.
  for (const answer of [
    { status: 403, body: { error: "NOT_HOST" } },
    { status: 200, body: { code: "BZQ7", exists: true } },
  ]) {
    await page.unroute(`${MOCK_URL}/rooms`);
    await page.route(`${MOCK_URL}/rooms`, (route) =>
      route.fulfill({ status: answer.status, contentType: "application/json", headers: CORS, body: JSON.stringify(answer.body) }),
    );
    await page.goto("/h/BZQ7");
    await expect(page.getByRole("heading", { name: "This hive is hosted on another phone" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: "Join it instead" })).toHaveAttribute("href", "/j/BZQ7");
    await expect(page.getByRole("link", { name: "Back home" })).toHaveAttribute("href", "/");
  }
});

test("host recovery: the server cannot be reached -> 'Try again' retries and gets through", async ({ page }) => {
  let down = true;
  await page.route(`${MOCK_URL}/rooms`, (route) => (down ? route.abort("connectionrefused") : route.continue()));
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("heading", { name: /reach the hive/ })).toBeVisible({ timeout: 10_000 });

  down = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: "Join QR code" })).toBeVisible({ timeout: 10_000 });
});
