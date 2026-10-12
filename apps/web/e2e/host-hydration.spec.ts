import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test("host page: reloading with a stored host key hydrates cleanly (no server/client mismatch)", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));

  await page.goto("/h/BZQ7"); // first visit: no key yet, the page claims one and stores it
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"))).toBeTruthy();

  errors.length = 0;
  await page.reload(); // every later visit: the key is in localStorage, which the server render cannot see
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});
