import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * Things that broke on real phone sizes: controls that could not be reached at all (off the edge of
 * a row with no cue, under a sheet with no way to close it, below a list that does not scroll) and
 * text that long song titles / player names pushed out of shape.
 */
const LONG_TITLE = "01 - Never Gonna Give You Up (2022 Remastered Extended Club Mix) [feat. Everybody And Their Friends] - Official Audio";
const LONG_NAME = "Christopher-Alexander Montgomery"; // 32 characters, the schema maximum

/** Long song title + long player names, straight into the snapshots the page renders. */
async function withLongStrings(page: Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "ROOM_STATE") {
        if (msg.room.track) msg.room.track.title = LONG_TITLE;
        const ids = Object.keys(msg.room.clients).filter((id) => id.startsWith("mock-"));
        if (ids[0]) msg.room.clients[ids[0]].name = LONG_NAME;
        if (ids[1]) msg.room.clients[ids[1]].name = "W".repeat(32);
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

test.describe("stopped stage", () => {
  test.use({ mockScenario: "join.json" });

  test("host layout: all six modes are on screen at 320 px — Strobe and Choir are not hidden off the edge of a row", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/h/BZQ7");
    await expect(page.getByRole("button", { name: "Unison" })).toBeVisible({ timeout: 10_000 });
    for (const mode of ["Unison", "Orchestra", "Stereo", "Wave", "Strobe", "Choir"]) {
      const chip = page.getByRole("button", { name: mode, exact: true });
      await chip.scrollIntoViewIfNeeded();
      const box = (await chip.boundingBox())!;
      expect(box.x, `${mode} left edge`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${mode} right edge`).toBeLessThanOrEqual(320);
      expect(box.height, `${mode} tap height`).toBeGreaterThanOrEqual(44);
    }
  });

  test("host layout: a 110-character song title takes two lines at most, on 'Up next' and on the transport bar", async ({ page }) => {
    await withLongStrings(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/h/BZQ7");
    const upNext = page.getByText("Up next:");
    await expect(upNext).toBeVisible({ timeout: 10_000 });
    expect((await upNext.boundingBox())!.height).toBeLessThanOrEqual(48);

    await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    const title = page.getByText(LONG_TITLE, { exact: true }).first();
    expect((await title.boundingBox())!.height).toBeLessThanOrEqual(52);
  });
});

test.describe("playing stage", () => {
  test.use({ mockScenario: "party-12.json" });

  test("host layout: every strobe division and group count is on screen at 320 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Strobe", exact: true }).click();
    await expect(page.getByText("Groups")).toBeVisible({ timeout: 10_000 });
    for (const label of ["1/2", "1/4", "1/8", "1/16", "2", "3", "4", "5", "6", "8"]) {
      const chip = page.getByRole("button", { name: label, exact: true });
      const box = (await chip.boundingBox())!;
      expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(320);
      expect(box.height, `${label} tap height`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${label} tap width`).toBeGreaterThanOrEqual(36);
    }
  });
});
