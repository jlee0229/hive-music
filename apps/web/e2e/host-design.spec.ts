/**
 * The host stage as a design: one scale for type, corners and controls; nothing under a 44 px
 * tap; the things a host reaches for on the first screen of a phone; and the founder's fixed
 * points about what the stage is and holds. Measured in the DOM.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const PHONES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
];
const LAPTOP = { width: 1280, height: 800 };

/** Font sizes, corner radii and control heights on the current screen that are off the scale, named. */
async function offScale(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const TYPE = [12, 14, 16, 20, 32];
    const RADII = [12, 16, 24];
    const CONTROLS = [44, 56, 64];
    const out: string[] = [];
    const say = (el: Element) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 24);
    for (const el of document.querySelectorAll<HTMLElement>("main *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
      if (ownText && !el.closest("[style*='font-size']") && !TYPE.includes(Math.round(parseFloat(cs.fontSize) * 10) / 10)) out.push(`type ${cs.fontSize} "${say(el)}"`);
      const radius = parseFloat(cs.borderTopLeftRadius);
      const pill = radius >= Math.min(r.width, r.height) / 2 - 0.5;
      if (radius > 0 && !pill && !RADII.includes(radius)) out.push(`radius ${radius} "${say(el)}"`);
      // One-line controls sit on 44 / 56 / 64. A list row (taller than 64) is as tall as its text.
      const control = el.tagName === "BUTTON" || el.tagName === "A" || (el.tagName === "LABEL" && !!el.querySelector("input"));
      const h = Math.round(r.height);
      if (control && h < 65 && !CONTROLS.includes(h) && r.height < innerHeight - 4) out.push(`control ${h} "${say(el)}"`);
    }
    return [...new Set(out)];
  });
}

/** Everything a finger is meant to hit that is smaller than 44 x 44. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("main button, main a[href], main [role=slider], main label:has(input)")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width >= innerWidth - 2 && r.height >= innerHeight - 2) continue; // a sheet's backdrop
      if (r.width < 44 || r.height < 44) out.push(`${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

async function openStage(page: Page) {
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("img", { name: /^Hive map/ })).toBeVisible({ timeout: 15_000 });
}

test.describe("playing stage (party-12)", () => {
  test.use({ mockScenario: "party-12.json" });

  test("host scale: stage, strobe controls, drawers, sheet and tuning use only the scale, and nothing is under 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openStage(page);
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    expect(await offScale(page), "stage").toEqual([]);
    expect(await smallTargets(page), "stage").toEqual([]);

    await page.getByRole("button", { name: "Strobe", exact: true }).click();
    await expect(page.getByText("Groups", { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(await offScale(page), "strobe").toEqual([]);
    expect(await smallTargets(page), "strobe").toEqual([]);
    await page.getByRole("button", { name: "Orchestra", exact: true }).click();

    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await expect(page.getByPlaceholder("Search the library")).toBeVisible();
    expect(await offScale(page), "songs").toEqual([]);
    await page.getByRole("button", { name: "Back to the stage" }).click();

    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(page.getByRole("button", { name: /Maya/ })).toBeVisible();
    expect(await offScale(page), "players").toEqual([]);
    await page.getByRole("button", { name: /Maya/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await offScale(page), "sheet").toEqual([]);
    // No raw timing numbers in the sheet: the three "compensation / nudge / table" tiles are gone.
    await expect(page.getByRole("dialog").getByText(/compensation|table/)).toHaveCount(0);
    await page.getByRole("button", { name: "Close player sheet" }).click();

    await page.getByRole("button", { name: "Tune the hive" }).click();
    await expect(page.getByText("Tuning moment")).toBeVisible();
    await expect(page.getByText("clear ✓").first()).toBeVisible({ timeout: 15_000 });
    expect(await offScale(page), "tuning").toEqual([]);
    // "clear" is the news; how many milliseconds late each phone was is not.
    expect(await page.locator("main").innerText()).not.toMatch(/\d\s?ms\b/);
  });

  for (const viewport of [...PHONES, LAPTOP]) {
    test(`host fit ${viewport.width}x${viewport.height}: play/pause, every mode, Songs and the QR link are on the first screen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openStage(page);
      for (const control of [
        page.getByRole("button", { name: "Pause" }),
        page.getByRole("link", { name: "Join QR code" }),
        page.getByRole("button", { name: "Unison", exact: true }),
        page.getByRole("button", { name: "Choir", exact: true }),
        page.getByRole("button", { name: "Songs", exact: true }),
        page.getByRole("button", { name: "Players", exact: true }),
        page.getByRole("button", { name: "Exit the hive" }),
      ]) {
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    });
  }

  test("host drawers: a drawer scrolls inside itself and the stage behind it never moves", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 659 });
    await openStage(page);
    for (const drawer of ["Songs", "Players"]) {
      await page.getByRole("button", { name: drawer, exact: true }).click();
      await expect(page.getByRole("button", { name: "Back to the stage" })).toBeInViewport({ ratio: 1 });
      await page.mouse.move(200, 300);
      for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 600);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => scrollY), `${drawer}: the page behind scrolled`).toBe(0);
      await expect(page.getByRole("button", { name: "Back to the stage" })).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "Back to the stage" }).click();
    }
    // ...and the stage scrolls again once the drawer is shut.
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });

  test("host players: the drawer counts the phones that are here, like the stage does", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await openStage(page);
    // party-12 seeds twelve phones, one of them gone.
    await expect(page.getByText("11 players")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Players", exact: true }).click();
    await expect(page.locator("div.fixed").getByText("11 players")).toBeVisible();
    await expect(page.getByText("sorted by sync health")).toHaveCount(0);
  });

  test("host legend: it names what the colours mean in the mode that is on", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await openStage(page);
    const legend = page.getByTestId("map-legend");
    await expect(legend).toContainText("drums");
    await page.getByRole("button", { name: "Choir", exact: true }).click();
    await expect(legend).toContainText("soprano", { timeout: 10_000 });
    await expect(legend).toContainText("basso");
    await expect(legend).toContainText("tenor");
    await expect(legend).not.toContainText("drums");
    await page.getByRole("button", { name: "Unison", exact: true }).click();
    await expect(legend).not.toContainText("soprano", { timeout: 10_000 });
    await expect(legend).not.toContainText("drums");
  });
});

test.describe("the founder's fixed points", () => {
  test.use({ mockScenario: "join.json" });

  test("host stage: it is the only host screen, and it holds the QR link, the speaker toggle, the byline and a way out", async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await openStage(page);
    await expect(page).toHaveTitle("Hosting hive BZQ7 · HiveMusic");

    // No lobby: the first thing a host sees is the stage, with Start on it.
    await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Join QR code" })).toHaveAttribute("href", "/qr/BZQ7");
    await expect(page.getByRole("checkbox", { name: "This phone plays music too" })).toBeVisible();
    await expect(page.locator("main").getByText("Creators: Frank Lucci & Jaeho Lee")).toBeVisible();

    // The song is changed from the stage, and changing it stays on the stage.
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await page.getByRole("button", { name: /Synthetic 30/ }).click();
    await expect(page.getByText("Up next:")).toContainText("Synthetic 30", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/h\/BZQ7$/);

    // Strobe keeps both of its controls; Choir is a mode.
    await expect(page.getByRole("button", { name: "Choir", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Strobe", exact: true }).click();
    await expect(page.getByText("Beat", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "1/16", exact: true })).toBeVisible();
    await expect(page.getByText("Groups", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unison", exact: true }).click();

    // The map: a calm black ring in unison, every phone named at once, the host as "Host", no
    // "drag me", no two dots on top of each other.
    await page.getByRole("checkbox", { name: "This phone plays music too" }).check();
    const map = page.getByRole("img", { name: /^Hive map/ });
    await expect(map.locator("g[data-client-id]")).toHaveCount(3, { timeout: 10_000 });
    const dots = await map.locator("g[data-client-id]").evaluateAll((groups) =>
      groups.map((g) => {
        const [ring, dot] = [...g.querySelectorAll("circle")];
        const label = [...g.querySelector("text")!.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("");
        return { ring: getComputedStyle(ring!).stroke, x: Number(dot!.getAttribute("cx")), y: Number(dot!.getAttribute("cy")), r: Number(dot!.getAttribute("r")), label };
      }),
    );
    expect(dots.map((d) => d.ring)).toEqual(dots.map(() => "rgb(11, 15, 20)"));
    expect(dots.every((d) => d.label.trim().length > 0)).toBe(true);
    expect(dots.map((d) => d.label)).toContain("Host");
    for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
      expect(Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y), `${dots[i]!.label} and ${dots[j]!.label} overlap`).toBeGreaterThanOrEqual(dots[i]!.r + dots[j]!.r);
    }
    expect(await page.locator("main").innerText()).not.toMatch(/drag me/i);

    // An obvious way out that ends the session.
    await page.getByRole("button", { name: "Exit the hive" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Host a hive" })).toBeVisible();
  });
});
