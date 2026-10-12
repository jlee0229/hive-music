/**
 * The playing screen paints the whole phone in the role colour and STROBE/WAVE dim it with a dark
 * overlay. WCAG 2.3.1: nothing may flash more than three times in any one second unless the flash
 * is below the general flash threshold (a swing under 10 % of full relative luminance). These
 * tests measure what the screen actually does, frame by frame, rather than trusting the formula.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "party-12.json" });

const GENERAL_FLASH_THRESHOLD = 0.1;

function relativeLuminance([r, g, b]: number[]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
const parseRgb = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);

/** Samples the dim overlay every animation frame and reduces it to the screen's luminance over time. */
async function measureFlashing(page: Page, ms = 2500) {
  const raw = await page.evaluate(async (windowMs) => {
    const main = document.querySelector("main")!;
    // Structural selector on purpose: it finds the overlay with or without a test id.
    const overlay = main.querySelector(":scope > div[aria-hidden='true']");
    const samples: Array<[number, number]> = [];
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const t = performance.now() - t0;
        samples.push([t, overlay ? Number(getComputedStyle(overlay).opacity) : 0]);
        if (t < windowMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return {
      samples,
      fill: getComputedStyle(main).backgroundColor,
      dark: overlay ? getComputedStyle(overlay).backgroundColor : "rgb(0, 0, 0)",
    };
  }, ms);

  const fill = parseRgb(raw.fill);
  const dark = parseRgb(raw.dark);
  const lum = raw.samples.map(([t, o]) => [t, relativeLuminance(fill.map((c, i) => c * (1 - o) + dark[i]! * o))] as const);
  const values = lum.map(([, l]) => l);
  const max = Math.max(...values);
  const min = Math.min(...values);
  // One flash = the screen going dark and coming back: count falling crossings of the midpoint.
  const mid = (max + min) / 2;
  let crossings = 0;
  for (let i = 1; i < lum.length; i++) if (lum[i - 1]![1] >= mid && lum[i]![1] < mid) crossings++;
  const seconds = (lum.at(-1)![0] - lum[0]![0]) / 1000;
  return { swing: max - min, flashesPerSec: max - min < 0.005 ? 0 : crossings / seconds, frames: lum.length };
}

async function joinPlaying(page: Page, name: string) {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
}

async function setStrobe(page: Page, params: { beatsPerSwitch: number; groups: number }) {
  const host = await connectAsHost("BZQ7");
  // periodMs/duty cover a mock track without a tempo; with one, beatsPerSwitch x groups decides.
  host.send({ type: "SET_MODE", mode: "STROBE", params: { ...params, periodMs: params.beatsPerSwitch < 1 ? 150 : 2000, duty: 0.5 } });
  await host.waitForRoomState();
  host.close();
  await expect(page.locator("main")).toContainText(/strobe \d/i, { timeout: 10_000 });
}

test("a sixteenth-note strobe never flashes the whole phone above the WCAG 2.3.1 threshold", async ({ page }) => {
  await joinPlaying(page, "Fast Strobe");
  // 120 bpm, 1/16 notes, 2 groups: each phone goes dark and lit again four times a second.
  await setStrobe(page, { beatsPerSwitch: 0.25, groups: 2 });

  const m = await measureFlashing(page);
  expect(m.frames).toBeGreaterThan(60);
  // Either it is not flashing faster than three times a second, or the flash is below threshold.
  expect(m.flashesPerSec <= 3 || m.swing < GENERAL_FLASH_THRESHOLD, `flashes/s ${m.flashesPerSec.toFixed(1)}, luminance swing ${m.swing.toFixed(3)}`).toBe(true);
});

test("a slow strobe keeps its full on/off contrast", async ({ page }) => {
  await joinPlaying(page, "Slow Strobe");
  // Half notes, 2 groups: one flash every two seconds — the effect the host asked for.
  await setStrobe(page, { beatsPerSwitch: 2, groups: 2 });

  const m = await measureFlashing(page, 4500);
  expect(m.flashesPerSec).toBeLessThanOrEqual(3);
  expect(m.swing).toBeGreaterThan(0.15);
});

test("prefers-reduced-motion: no strobing at all", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await joinPlaying(page, "Reduced Motion");
  await setStrobe(page, { beatsPerSwitch: 2, groups: 2 });

  const m = await measureFlashing(page, 4500);
  expect(m.swing, `luminance swing ${m.swing.toFixed(3)}`).toBeLessThan(0.01);
  // The role is still stated in words, so nothing is lost but the flashing.
  await expect(page.locator("main")).toContainText(/strobe \d/i);
});
