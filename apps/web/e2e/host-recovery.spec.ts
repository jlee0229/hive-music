import { connectAsHost } from "./helpers/host-driver";
import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

/**
 * Every way the host page can fail to become the host must end on a screen that says what happened
 * and has a way out — never a spinner that spins forever, never a dead stage. These run against the
 * mock's real answers (it mirrors the server's host-key contract): the key is never handed to a
 * browser that does not already hold it.
 */
test.use({ mockScenario: "join.json", seedHostKey: false }); // these browsers are NOT the phone that created the hive

/** Every POST /rooms body the page sends. */
function watchRoomPosts(page: import("@playwright/test").Page): Array<{ code?: string; hostKey?: string }> {
  const posts: Array<{ code?: string; hostKey?: string }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${MOCK_URL}/rooms`) posts.push(r.postDataJSON() ?? {});
  });
  return posts;
}

test("host recovery: a stored key for a hive that is gone (NO_ROOM) -> 'This hive has ended', a way to start a new one, and the dead key is dropped", async ({ page }) => {
  // The key could not bring the room back (too old, or from before the server's secret changed), so
  // the JOIN is answered with ERROR NO_ROOM.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) localStorage.setItem("hive:hostKey:NOPE", "key-of-a-room-that-is-gone");
    sessionStorage.setItem("seeded", "1");
  });
  await page.goto("/h/NOPE");

  await expect(page.getByRole("heading", { name: "This hive has ended" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Start a new hive" })).toHaveAttribute("href", "/");
  await expect(page.getByText("Setting up your hive")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:NOPE"))).toBeNull();
});

test("host recovery: no key and no such hive (400) -> 'This hive has ended', not 'is the server running?'", async ({ page }) => {
  const posts = watchRoomPosts(page);
  await page.goto("/h/NOPE");
  await expect(page.getByRole("heading", { name: "This hive has ended" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Start a new hive" })).toHaveAttribute("href", "/");
  expect(posts.every((p) => p.code === "NOPE" && !p.hostKey)).toBe(true);
  expect(posts.length).toBeGreaterThan(0);
});

test("host recovery: no key and a live hive (403) -> 'hosted on another device': join as a guest or start a new hive, and the page never joins the room", async ({ page }) => {
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => frames.push(String(f.payload))));
  await page.goto("/h/BZQ7");

  await expect(page.getByRole("heading", { name: "This hive is hosted on another device" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Join as a guest" })).toHaveAttribute("href", "/j/BZQ7");
  await expect(page.getByRole("link", { name: "Start a new hive" })).toHaveAttribute("href", "/");
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"))).toBeNull(); // nothing was handed out
  expect(frames.filter((f) => f.includes('"JOIN"'))).toEqual([]); // and it did not sit in the room as a speaker
});

test("host recovery: a key that is not this hive's -> 'hosted on another device', the key is kept, and the page leaves the room at once", async ({ page }) => {
  // Someone else's hive under a code this browser once hosted: the JOIN is admitted as a plain guest —
  // a speaker — because the server cannot tell this page from a phone. It must not stay.
  const realHost = await connectAsHost("BZQ7");
  const posts = watchRoomPosts(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) localStorage.setItem("hive:hostKey:BZQ7", "a-key-from-another-life");
    sessionStorage.setItem("seeded", "1");
  });
  await page.goto("/h/BZQ7");

  await expect(page.getByRole("heading", { name: "This hive is hosted on another device" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Join as a guest" })).toHaveAttribute("href", "/j/BZQ7");
  // Not thrown away to "re-claim" one (the old recovery did that; the server now answers it with 403).
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"))).toBe("a-key-from-another-life");
  expect(posts.filter((p) => !p.hostKey)).toEqual([]);

  // The guest seat it was given is released: it was in the room, and it is no longer connected.
  const guests = () => Object.values(realHost.latestRoom()?.clients ?? {}).filter((c) => c.kind === "player" && !c.id.startsWith("mock-"));
  await expect.poll(() => guests().length, { timeout: 10_000 }).toBeLessThanOrEqual(1);
  await expect.poll(() => guests().filter((c) => c.connected).length, { timeout: 10_000 }).toBe(0);
  realHost.close();
});

test("host recovery: the server cannot be reached -> 'Try again' asks again and gets an answer", async ({ page }) => {
  let down = true;
  await page.route(`${MOCK_URL}/rooms`, (route) => (down ? route.abort("connectionrefused") : route.continue()));
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("heading", { name: /reach the hive/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Back home" })).toHaveAttribute("href", "/");

  down = false;
  await page.getByRole("button", { name: "Try again" }).click();
  // The answer, for a browser without the key, is the server's refusal — not a spinner, not the same error.
  await expect(page.getByRole("heading", { name: "This hive is hosted on another device" })).toBeVisible({ timeout: 10_000 });
});
