import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("a PROTOCOL_VERSION mismatch reloads once, then shows a banner instead of looping", async ({ page }) => {
  // The mock always reports its own real PROTOCOL_VERSION over /health; route around that to
  // simulate a bundle skew without touching packages/protocol.
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true, protocolVersion: 999_999, serverTime: Date.now(), mock: true } }),
  );

  // Committed navigations, not "load" events: on a slow machine the guard's reload can land before
  // the first document has finished loading, and then that document never fires "load" at all.
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });

  await page.goto("/j/BZQ7", { waitUntil: "commit" });
  // One for the initial navigation, a second once the guard's one-shot reload fires.
  await expect.poll(() => navigations, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

  await expect(page.getByRole("alert").filter({ hasText: "older version" })).toBeVisible({ timeout: 10_000 });
});

test("a PROTOCOL_VERSION mismatch with sessionStorage blocked shows the banner at once — it does not reload for ever", async ({ page }) => {
  // Safari with all cookies blocked, Chrome with site data blocked, some in-app webviews: touching
  // sessionStorage throws. Nothing can remember "already reloaded", so there must be no reload at all.
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true, protocolVersion: 999_999, serverTime: Date.now(), mock: true } }),
  );

  let loads = 0;
  page.on("load", () => loads++);

  await page.goto("/j/BZQ7");
  await expect(page.getByRole("alert").filter({ hasText: "older version" })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500); // the old loop reloaded several times a second
  expect(loads).toBe(1);
});
