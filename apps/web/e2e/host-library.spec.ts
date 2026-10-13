import type { Page, Route } from "@playwright/test";
import { MOCK_HOST_KEY } from "./helpers/host-key";
import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

/**
 * Owned uploads, the host's side: the library is asked for as this hive's host, a song this browser
 * uploaded (`mine`) can be removed with a confirm in place, and the browser's library key is made
 * once, kept, and never put in a URL. The mock's library is all shared (nothing is `mine`, DELETE
 * answers not_owner), so the owned song and the server's answers are supplied per test.
 */
test.use({ mockScenario: "join.json" });

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization" };
const MINE = { id: "my-upload-1a2b3c4d", title: "My Upload", durationSec: 201, stems: ["mix"], urls: { mix: `${MOCK_URL}/audio/x/mix.wav` }, mine: true };

/** GET /tracks answers with the mock's shared songs plus (while `present()`) one owned upload; records the Authorization headers it saw. */
async function withOwnedSong(page: Page, present: () => boolean = () => true): Promise<{ listAuth: string[] }> {
  const listAuth: string[] = [];
  await page.route(`${MOCK_URL}/tracks`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    listAuth.push(route.request().headers()["authorization"] ?? "");
    const res = await route.fetch();
    const body = (await res.json()) as { tracks: unknown[] };
    if (present()) body.tracks.push(MINE);
    await route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
  });
  return { listAuth };
}

async function openSongs(page: Page) {
  await page.goto("/h/BZQ7");
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await expect(page.getByRole("button", { name: "My Upload", exact: false }).first()).toBeVisible({ timeout: 10_000 });
}

test("host library: the list is asked for as the host, and only this browser's own upload has a remove control", async ({ page }) => {
  const { listAuth } = await withOwnedSong(page);
  await openSongs(page);

  expect(listAuth.length).toBeGreaterThan(0);
  expect(listAuth.every((h) => h === `Bearer ${MOCK_HOST_KEY}`)).toBe(true);

  await expect(page.getByRole("button", { name: "Remove My Upload" })).toBeVisible();
  // Shared songs: no control, nothing else that marks them either (no badges, no sections).
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Synthetic 60/ })).toHaveCount(1);
  await expect(page.getByText(/shared|my songs|yours/i)).toHaveCount(0);
});

test("host library: remove asks once in place, then deletes as the host and the list is fetched again", async ({ page }) => {
  let gone = false;
  const deletes: Array<{ url: string; auth: string }> = [];
  const { listAuth } = await withOwnedSong(page, () => !gone);
  await page.route(`${MOCK_URL}/tracks/*`, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes.push({ url: route.request().url(), auth: route.request().headers()["authorization"] ?? "" });
    gone = true;
    await route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify({ ok: true }) });
  });
  await openSongs(page);

  const remove = page.getByRole("button", { name: "Remove My Upload" });
  await remove.click();
  expect(deletes).toEqual([]); // the first tap only asks
  const confirm = page.getByRole("button", { name: /Remove My Upload\? Tap again/ });
  await expect(confirm).toHaveText("Remove?");

  const listsBefore = listAuth.length;
  await confirm.click();
  await expect(page.getByRole("button", { name: /My Upload/ })).toHaveCount(0, { timeout: 10_000 });
  expect(deletes).toEqual([{ url: `${MOCK_URL}/tracks/${MINE.id}`, auth: `Bearer ${MOCK_HOST_KEY}` }]);
  expect(listAuth.length).toBeGreaterThan(listsBefore);
  await expect(page.locator(".fixed").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Synthetic 60/ })).toBeVisible(); // the shared songs are untouched
});

test("host library: an unanswered 'Remove?' lets go by itself, and picking the song instead does not remove it", async ({ page }) => {
  let deleted = 0;
  await withOwnedSong(page);
  await page.route(`${MOCK_URL}/tracks/*`, (route) => {
    if (route.request().method() === "DELETE") deleted++;
    return route.fallback();
  });
  await openSongs(page);
  await page.getByRole("button", { name: "Remove My Upload" }).click();
  await expect(page.getByRole("button", { name: /Tap again/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Tap again/ })).toHaveCount(0, { timeout: 8_000 });
  await expect(page.getByRole("button", { name: "Remove My Upload" })).toBeVisible();
  expect(deleted).toBe(0);
});

test("host library: a song that is playing somewhere (409 in_use) stays, with one sentence", async ({ page }) => {
  await withOwnedSong(page);
  await page.route(`${MOCK_URL}/tracks/*`, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 409, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "in_use" }) })
      : route.fallback(),
  );
  await openSongs(page);
  await page.getByRole("button", { name: "Remove My Upload" }).click();
  await page.getByRole("button", { name: /Tap again/ }).click();
  await expect(page.locator(".fixed").getByRole("alert")).toHaveText("That song is playing — pick another first.", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Remove My Upload" })).toBeVisible();
});

test("host library: the mock's own answer (nothing is owned -> 403 not_owner) is a sentence, not a code", async ({ page }) => {
  await withOwnedSong(page); // the list says `mine`; the mock's DELETE says otherwise
  await openSongs(page);
  await page.getByRole("button", { name: "Remove My Upload" }).click();
  await page.getByRole("button", { name: /Tap again/ }).click();
  const alert = page.locator(".fixed").getByRole("alert");
  await expect(alert).toHaveText("That song can’t be removed.", { timeout: 10_000 });
  await expect(alert).not.toContainText(/not_owner|403/);
});

test("host library: the browser's library key is made once, kept across reloads, and never appears in a URL", async ({ page }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("websocket", (ws) => urls.push(ws.url()));

  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  const key = await page.evaluate(() => localStorage.getItem("hive:libraryKey"));
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url

  await page.getByRole("button", { name: "Songs", exact: true }).click(); // a library fetch
  await page.getByRole("button", { name: "Back to the stage" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => localStorage.getItem("hive:libraryKey"))).toBe(key);

  await page.goto("/qr/BZQ7");
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => localStorage.getItem("hive:libraryKey"))).toBe(key);

  expect(urls.length).toBeGreaterThan(5);
  expect(urls.filter((u) => u.includes(key!))).toEqual([]);
  expect(page.url()).not.toContain(key!);
});
