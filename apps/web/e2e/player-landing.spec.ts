/** The landing page: the code box a guest types into, and what "Host a hive" does when it can't. */
import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

test.describe("joining by code", () => {
  test("codes are forgiven their spaces, dashes and case, and Enter joins", async ({ page }) => {
    await page.goto("/");
    const input = page.getByLabel("Hive code");

    await input.fill("bz q7");
    await expect(input).toHaveValue("BZQ7");
    await input.fill("bz-q7 ");
    await expect(input).toHaveValue("BZQ7");

    await input.press("Enter");
    await expect(page).toHaveURL(/\/j\/BZQ7$/);
  });

  test("pasting the whole join link works", async ({ page }) => {
    await page.goto("/");
    const input = page.getByLabel("Hive code");
    await input.fill("https://playhivemusic.com/j/bzq7");
    await expect(input).toHaveValue("BZQ7");
  });

  test("the code box is set up for a phone keyboard and does not show a real-looking code", async ({ page }) => {
    await page.goto("/");
    const input = page.getByLabel("Hive code");
    await expect(input).toHaveAttribute("autocapitalize", "characters");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("autocorrect", "off");
    await expect(input).toHaveAttribute("enterkeyhint", "go");
    // BZQ7 was the fixed demo code; as a placeholder it read as "type this".
    await expect(input).not.toHaveAttribute("placeholder", "BZQ7");
    // 16 px or more, or iOS zooms the page when the field takes focus.
    expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  });

  test("Join with too short a code says what to do instead of doing nothing", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Hive code").fill("B");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText(/code/i);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("Hive code")).toBeFocused();
  });
});

test.describe("Host a hive", () => {
  test("server unreachable: a plain-language error, and the button works again", async ({ page }) => {
    await page.route("**/rooms", (route) => (route.request().method() === "POST" ? route.abort("connectionrefused") : route.continue()));
    await page.goto("/");
    await page.getByRole("button", { name: "Host a hive" }).click();

    const alert = page.locator("main").getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText(/is it running|server/i); // that is a message for a developer
    await expect(page.getByRole("button", { name: "Host a hive" })).toBeEnabled();
  });

  test("server never answers: gives up after ten seconds instead of spinning forever", async ({ page }) => {
    await page.clock.install();
    await page.route("**/rooms", (route) => (route.request().method() === "POST" ? new Promise(() => {}) : route.continue()));
    await page.goto("/");
    await page.getByRole("button", { name: "Host a hive" }).click();
    await expect(page.getByRole("button", { name: "Creating your hive…" })).toBeDisabled();

    await page.clock.fastForward(11_000);
    await expect(page.locator("main").getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Host a hive" })).toBeEnabled();
  });

  test("a double tap creates one hive", async ({ page }) => {
    let posts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/rooms") posts++;
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Host a hive" }).dblclick();
    await expect(page).toHaveURL(/\/h\//, { timeout: 10_000 });
    expect(posts).toBe(1);
  });
});

test("320 px wide: no sideways scroll, every control on the page is reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  for (const control of [page.getByRole("button", { name: "Host a hive" }), page.getByLabel("Hive code"), page.getByRole("button", { name: "Join" })]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.height).toBeGreaterThanOrEqual(44); // minimum comfortable tap target
  }
  const github = page.getByRole("link", { name: "HiveMusic on GitHub" });
  await expect(github).toHaveAttribute("target", "_blank");
  await expect(github).toHaveAttribute("rel", /noreferrer/);
});
