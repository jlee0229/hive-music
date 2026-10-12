/**
 * Who a phone is, across reloads, tabs and browsers. Identity is `hive:clientId:<code>` in
 * localStorage; every page of one browser profile shares it, which is the point for a reload and a
 * trap for a second role in the same browser.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "join.json" });

async function roomSnapshot() {
  const host = await connectAsHost("BZQ7");
  const next = host.waitForRoomState();
  host.send({ type: "SET_PLAYS", plays: false });
  const { room } = await next;
  host.close();
  return room;
}

async function join(page: Page, name: string) {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
}

test("the join link opened in the host's own browser does not take over the host's record", async ({ page }) => {
  // What the host page leaves behind in this browser: the room's host key and the host's client id.
  await page.goto("/qr/BZQ7");
  await page.evaluate(() => {
    localStorage.setItem("hive:hostKey:BZQ7", "mock-host-key");
    localStorage.setItem("hive:clientId:BZQ7", "the-hosts-own-client-id-01");
  });

  await join(page, "Second Tab");

  const room = await roomSnapshot();
  expect(room.clients["the-hosts-own-client-id-01"], "the join tab JOINed as the host's client id").toBeUndefined();
  const guests = Object.values(room.clients).filter((c) => c.name === "Second Tab");
  expect(guests).toHaveLength(1);
  expect(guests[0]).toMatchObject({ kind: "player", plays: true });

  // and it is a stable second identity, not a new one per load
  const first = guests[0]!.id;
  await page.reload();
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(Object.values((await roomSnapshot()).clients).filter((c) => c.name === "Second Tab").map((c) => c.id)).toEqual([first]);
});

test("a guest who reloads comes back as the same phone, not a second one", async ({ page }) => {
  await join(page, "Reloader");
  const id = await page.evaluate(() => localStorage.getItem("hive:clientId:BZQ7"));

  await page.reload();
  await expect(page.getByPlaceholder("Your name")).toHaveValue("Reloader");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });

  const mine = Object.values((await roomSnapshot()).clients).filter((c) => c.name === "Reloader");
  expect(mine.map((c) => c.id)).toEqual([id]);
});

test("with storage blocked (private mode) a guest can still join", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Storage.prototype.getItem = deny;
    Storage.prototype.setItem = deny;
    Storage.prototype.removeItem = deny;
  });
  await join(page, "Incognito");
  expect(Object.values((await roomSnapshot()).clients).filter((c) => c.name === "Incognito")).toHaveLength(1);
});
