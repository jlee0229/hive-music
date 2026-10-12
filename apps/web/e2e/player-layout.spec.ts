/**
 * The ready and playing screens are deliberately no-scroll (h-dvh, overflow hidden), so anything
 * that does not fit is silently cut off rather than scrolled to. These tests put the screens on
 * the smallest phones still in use and in landscape, and fail on any text or control that falls
 * outside the screen.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

const SMALL_PHONE = { width: 320, height: 568 };
const LANDSCAPE = { width: 667, height: 375 };
const LONG_TITLE = "Supercalifragilisticexpialidocious (Extended Club Remix) [feat. A Very Long Featured Artist] — Live";

/** Text and controls inside <main> that are cut off by the screen edge or by <main>'s clipping box. */
async function clippedContent(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const main = document.querySelector("main")!;
    const box = main.getBoundingClientRect();
    const bottom = Math.min(box.bottom, window.innerHeight);
    const out: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>("*")) {
      const ownText = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()).map((n) => n.textContent!.trim()).join(" ");
      if (!ownText && el.tagName !== "BUTTON") continue;
      if (el.closest("[aria-hidden='true']") || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // display:none — dropped whole, which is fine
      // An ancestor that clips (the truncated title, the middle column) can cut it too.
      let visible = { top: Math.max(box.top, 0), bottom, left: 0, right: window.innerWidth };
      for (let p = el.parentElement; p && p !== main.parentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflow === "visible") continue;
        const pr = p.getBoundingClientRect();
        visible = { top: Math.max(visible.top, pr.top), bottom: Math.min(visible.bottom, pr.bottom), left: Math.max(visible.left, pr.left), right: Math.min(visible.right, pr.right) };
      }
      const ellipsis = getComputedStyle(el).textOverflow === "ellipsis";
      const cut = r.bottom > visible.bottom + 1 || r.top < visible.top - 1 || (!ellipsis && (r.right > visible.right + 1 || r.left < visible.left - 1));
      if (cut) out.push(ownText.slice(0, 40) || el.tagName);
    }
    return out;
  });
}

async function join(page: Page, name: string) {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
}

test.describe("playing screen", () => {
  test.use({ mockScenario: "party-12.json" });

  async function strobe(page: Page) {
    const host = await connectAsHost("BZQ7");
    // "STROBE 1" is the longest label a phone can be given; slow enough that it is not dimmed away.
    host.send({ type: "SET_MODE", mode: "STROBE", params: { beatsPerSwitch: 4, groups: 2, periodMs: 8000, duty: 0.5 } });
    await host.waitForRoomState();
    host.close();
    await expect(page.locator("main")).toContainText(/strobe \d/i, { timeout: 10_000 });
  }

  test("320x568: the longest role label fits on one line and nothing is cut off", async ({ page }) => {
    await page.setViewportSize(SMALL_PHONE);
    await join(page, "Small Phone");
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });
    await strobe(page);

    const label = page.locator("main span.font-display").filter({ hasText: /strobe/i });
    const box = (await label.boundingBox())!;
    const fontSize = await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(SMALL_PHONE.width);
    expect(box.height, "label wrapped onto a second line").toBeLessThan(fontSize * 1.5);

    expect(await clippedContent(page)).toEqual([]);
    await expect(page.getByRole("button", { name: "Mute my phone" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText(/Creators:/)).toBeInViewport({ ratio: 1 });
  });

  test("667x375 landscape: the mute button is fully on screen and nothing is half cut off", async ({ page }) => {
    await page.setViewportSize(LANDSCAPE);
    await join(page, "Sideways");
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

    expect(await clippedContent(page)).toEqual([]);
    await expect(page.getByRole("button", { name: "Mute my phone" })).toBeInViewport({ ratio: 1 });
  });

  test("a 100-character song title stays on one line and keeps the clock visible", async ({ page }) => {
    await page.setViewportSize(SMALL_PHONE);
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        const msg = JSON.parse(String(message));
        if (msg.type === "ROOM_STATE" && msg.room.track) msg.room.track.title = LONG_TITLE;
        ws.send(JSON.stringify(msg));
      });
    });
    await join(page, "Long Title");
    await expect(page.getByText("YOU ARE")).toBeVisible({ timeout: 10_000 });

    const title = page.getByText(LONG_TITLE);
    await expect(title).toBeVisible();
    expect((await title.boundingBox())!.height).toBeLessThan(30);
    await expect(page.getByText(/· \d+:\d\d/)).toBeInViewport({ ratio: 1 });
    expect(await clippedContent(page)).toEqual([]);
  });
});

test.describe("ready screen", () => {
  // transport stopped: a joiner lands on Ready and stays there.
  test.use({ mockScenario: "join.json" });

  for (const viewport of [SMALL_PHONE, { width: 360, height: 640 }, LANDSCAPE]) {
    test(`${viewport.width}x${viewport.height}: the wait message, sponsor slot and creators line are all on screen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await join(page, "Bartholomew Fitzgerald-Montgomer"); // 32 characters, the longest a name can be
      await expect(page.getByText("YOU'LL PLAY")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/\d \/ \d parts/)).toBeVisible();

      expect(await clippedContent(page)).toEqual([]);
      await expect(page.getByText("Waiting for the host to start")).toBeInViewport({ ratio: 1 });
      await expect(page.getByText("Sponsored")).toBeInViewport({ ratio: 1 });
      await expect(page.getByText(/Creators:/)).toBeInViewport({ ratio: 1 });
      // The name is one line, however long.
      expect((await page.getByText("Bartholomew Fitzgerald-Montgomer").boundingBox())!.height).toBeLessThan(30);
    });
  }
});
