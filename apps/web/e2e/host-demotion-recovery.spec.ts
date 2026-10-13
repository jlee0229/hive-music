import { MOCK_HOST_KEY } from "./helpers/host-key";
import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

/**
 * A host page that holds the key and is told "NOT_HOST" all the same. The server no longer demotes
 * a keyed host, so this is rare — but the old recovery for it (throw the key away, re-claim one with
 * `POST /rooms {code}`) is exactly the request the server now refuses with 403, and would lock the
 * real host out. The page keeps its key and asks about it instead.
 *
 * (History: this file used to assert that a *stale* key is replaced via POST /rooms, then that a
 * stale key on a host-less room is accepted outright. Neither is true any more — a key that is not
 * the room's never makes anyone host; see host-recovery.spec.ts for those cases.)
 */
test.use({ mockScenario: "join.json" }); // seeded with the room's real key (fixtures.ts)

/** Lets a test put one ERROR NOT_HOST into the page's socket, as if a command had been refused. */
async function refusable(page: import("@playwright/test").Page): Promise<{ refuse: () => void; joins: Array<{ clientId: string; hostKey?: string }> }> {
  const joins: Array<{ clientId: string; hostKey?: string }> = [];
  let current: { send: (m: string) => void } | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    current = { send: (m) => ws.send(m) };
  });
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      const text = String(f.payload);
      if (text.includes('"JOIN"')) joins.push(JSON.parse(text));
    }),
  );
  return { refuse: () => current!.send(JSON.stringify({ type: "ERROR", code: "NOT_HOST", message: "host only" })), joins };
}

test("host demotion: NOT_HOST with a good key -> the page asks about its key (keeping it), re-joins under a fresh client id and is host again", async ({ page }) => {
  const posts: Array<{ code?: string; hostKey?: string }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url() === `${MOCK_URL}/rooms`) posts.push(r.postDataJSON() ?? {});
  });
  const socket = await refusable(page);

  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  expect(posts).toEqual([]); // a page that holds the key does not ask anything before joining

  socket.refuse();

  // Back on the stage, as host, without a reload.
  await expect.poll(() => socket.joins.length, { timeout: 10_000 }).toBe(2);
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  expect(posts).toEqual([{ code: "BZQ7", hostKey: MOCK_HOST_KEY }]); // never a key-less re-claim
  expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"))).toBe(MOCK_HOST_KEY);
  expect(socket.joins[1]!.hostKey).toBe(MOCK_HOST_KEY);
  expect(socket.joins[1]!.clientId).not.toBe(socket.joins[0]!.clientId);

  // Fully functional as host afterwards -- not just visually present.
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
});

test("host demotion: NOT_HOST and the server does not confirm the key -> 'hosted on another device', no loop", async ({ page }) => {
  let posts = 0;
  await page.route(`${MOCK_URL}/rooms`, (route) => {
    posts++;
    return route.fulfill({ status: 403, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "NOT_HOST" }) });
  });
  const socket = await refusable(page);

  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: /Start the hive|Start anyway/ })).toBeVisible({ timeout: 10_000 });
  socket.refuse();

  await expect(page.getByRole("heading", { name: "This hive is hosted on another device" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Join as a guest" })).toHaveAttribute("href", "/j/BZQ7");
  await expect(page.getByRole("link", { name: "Start a new hive" })).toHaveAttribute("href", "/");
  await page.waitForTimeout(1000);
  expect(posts).toBe(1);
  expect(socket.joins.length).toBe(1);
});
