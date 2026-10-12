/** What a guest can type as a name, and what the rest of the room then has to look at. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "join.json" });

/** This page's own record, as the server holds it. */
async function myRecord(page: Page) {
  const id = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));
  const host = await connectAsHost("BZQ7");
  const next = host.waitForRoomState();
  host.send({ type: "SET_PLAYS", plays: false });
  const { room } = await next;
  host.close();
  return room.clients[id!];
}

async function joinAs(page: Page, name: string) {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
}

test("a name of spaces is not sent: the host sees a real label, not a blank", async ({ page }) => {
  await joinAs(page, "   ");
  const me = await myRecord(page);
  expect(me, "this phone is not in the room").toBeDefined();
  expect(me!.name).toMatch(/\S/);
  // and this phone's own header does not show a blank either
  await expect(page.getByText("You", { exact: true })).toBeVisible();
});

test("a name is trimmed", async ({ page }) => {
  await joinAs(page, "  Sam  ");
  expect((await myRecord(page))!.name).toBe("Sam");
});

test("a long emoji name is cut on a whole character and still joins", async ({ page }) => {
  // 1 + 20 x 2 = 41 UTF-16 units; a cut at 32 lands in the middle of an emoji.
  const typed = "a" + "🎉".repeat(20);
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(typed);

  const value = await page.getByPlaceholder("Your name").inputValue();
  expect(value.length).toBeLessThanOrEqual(32);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value), "name ends in half an emoji").toBe(false);

  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect((await myRecord(page))!.name).toBe(value);
});

test("a 32-character name is accepted whole", async ({ page }) => {
  const name = "Bartholomew Fitzgerald-Montgomer";
  expect(name).toHaveLength(32);
  await joinAs(page, name);
  expect((await myRecord(page))!.name).toBe(name);
});

test("Enter in the name box joins", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Keyboard");
  await page.getByPlaceholder("Your name").press("Enter");
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
});

test("HTML in a name is shown as text on the projector, never run", async ({ page, browser }) => {
  const hostile = "<img src=x onerror=alert(1)>";
  await joinAs(page, hostile);

  const projector = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const screen = await projector.newPage();
  let dialogs = 0;
  screen.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });
  await screen.goto("/screen/BZQ7");
  await expect(screen.locator("svg[aria-label^='Hive map'] text").filter({ hasText: hostile })).toHaveCount(1, { timeout: 10_000 });
  await expect(screen.locator("img[src='x']")).toHaveCount(0);
  expect(dialogs).toBe(0);
  await projector.close();
});
