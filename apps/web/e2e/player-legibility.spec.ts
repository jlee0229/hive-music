/**
 * The role label has to stay readable through the whole STROBE/WAVE cycle, not only while the
 * phone is lit: the "off" phase dims the role colour to near-black, and the ink used to stay dark.
 */
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "party-12.json" });

function relativeLuminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
const parseRgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test("the role label keeps a readable contrast through the dim half of a strobe", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Legible");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

  // Half notes x 2 groups: lit for a second, dimmed for a second — slow enough to read in both.
  const host = await connectAsHost("BZQ7");
  host.send({ type: "SET_MODE", mode: "STROBE", params: { beatsPerSwitch: 2, groups: 2, periodMs: 2000, duty: 0.5 } });
  await host.waitForRoomState();
  host.close();
  await expect(page.locator("main")).toContainText(/strobe \d/i, { timeout: 10_000 });

  const raw = await page.evaluate(async () => {
    const main = document.querySelector("main")!;
    const overlay = main.querySelector(":scope > div[aria-hidden='true']")!;
    const label = [...main.querySelectorAll("span")].find((s) => /strobe/i.test(s.textContent ?? ""))!;
    const samples: Array<{ o: number; ink: string }> = [];
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        samples.push({ o: Number(getComputedStyle(overlay).opacity), ink: getComputedStyle(label).color });
        if (performance.now() - t0 < 4500) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { samples, fill: getComputedStyle(main).backgroundColor, dark: getComputedStyle(overlay).backgroundColor };
  });

  const fill = parseRgb(raw.fill);
  const dark = parseRgb(raw.dark);
  const ratios = raw.samples.map(({ o, ink }) => contrast(relativeLuminance(parseRgb(ink)), relativeLuminance(fill.map((c, i) => c * (1 - o) + dark[i]! * o))));
  // The test is only meaningful if it saw both phases.
  expect(Math.max(...raw.samples.map((s) => s.o))).toBeGreaterThan(0.7);
  expect(Math.min(...raw.samples.map((s) => s.o))).toBeLessThan(0.1);
  // 3:1 is the WCAG AA floor for large text; the flip point between inks sits a little above 4:1.
  expect(Math.min(...ratios), `worst contrast over the cycle ${Math.min(...ratios).toFixed(2)}:1`).toBeGreaterThan(4);
});
