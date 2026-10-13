import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

test.use({ mockScenario: "party-12.json" });

/** The room as the server sees it right now (a host command forces a fresh snapshot). */
async function roomSnapshot() {
  const host = await connectAsHost("BZQ7");
  const next = host.waitForRoomState();
  host.send({ type: "SET_PLAYS", plays: false });
  const { room } = await next;
  host.close();
  return room;
}

test("F-screen: /screen shows the code, QR, player count excluding itself, and a read-only map", async ({ page }) => {
  await page.goto("/screen/BZQ7");

  await expect(page.getByText("BZQ7", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();

  // party-12.json seeds 12 players; one (Omar, health "bad") is disconnected. Both the "Players"
  // tile and the map show who is in the room right now, so both say 11. (The map used to keep
  // disconnected phones and this test expected 12; HiveMap deliberately stopped drawing phones
  // that have left, and the expectation follows it.) The projector itself is a viewer: it must
  // not add to either number.
  await expect(page.getByText("11", { exact: true })).toBeVisible({ timeout: 10_000 });

  const map = page.getByRole("img", { name: "Hive map: 11 player phones" });
  await expect(map).toBeVisible();
  await expect(page.locator('g[data-client-id="mock-01-maya"]')).toBeVisible();
  await expect(page.locator("svg[aria-label^='Hive map'] text").filter({ hasText: /^Screen/ })).toHaveCount(0);

  // Read-only: dragging a dot must never emit SET_POSITION.
  const sent: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      const parsed = JSON.parse(text);
      sent.push(parsed.type);
    });
  });
  const dot = page.locator('g[data-client-id="mock-01-maya"] circle').first();
  const box = await dot.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 60, box!.y + 40);
  await page.mouse.up();
  expect(sent).not.toContain("SET_POSITION");
  expect(sent).not.toContain("ASSIGN");

  // No host controls anywhere on the page.
  await expect(page.getByRole("button", { name: /start|pause|tune|assign/i })).toHaveCount(0);
});

test("/screen joins as a viewer: not a speaker, not a player, never handed a part", async ({ page }) => {
  await page.goto("/screen/BZQ7");
  await expect(page.getByRole("img", { name: /^Hive map/ })).toBeVisible({ timeout: 10_000 });

  const room = await roomSnapshot();
  const screens = Object.values(room.clients).filter((c) => /^Screen/.test(c.name));
  expect(screens).toHaveLength(1);
  expect(screens[0]).toMatchObject({ kind: "viewer", plays: false, assignment: null });
});

test("/screen never takes over the identity this browser already has in the room", async ({ page }) => {
  // The laptop on the projector is usually the host's: its browser already holds the room's
  // client id. The projector tab must come in as somebody else.
  await page.goto("/qr/BZQ7"); // any same-origin page, to seed storage before /screen loads
  await page.evaluate(() => localStorage.setItem("hive:clientId:BZQ7", "this-browsers-own-id-0001"));

  await page.goto("/screen/BZQ7");
  await expect(page.getByRole("img", { name: /^Hive map/ })).toBeVisible({ timeout: 10_000 });

  const room = await roomSnapshot();
  expect(room.clients["this-browsers-own-id-0001"], "the projector joined under this browser's player/host id").toBeUndefined();
  expect(Object.values(room.clients).filter((c) => c.kind === "viewer")).toHaveLength(1);
});

for (const projector of [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
]) {
  test(`/screen fits a ${projector.width}x${projector.height} projector without scrolling`, async ({ page }) => {
    await page.setViewportSize(projector);
    await page.goto("/screen/BZQ7");
    const map = page.getByRole("img", { name: /^Hive map/ });
    await expect(map).toBeVisible({ timeout: 10_000 });

    // Nobody can scroll a projector: everything has to be on the one screen.
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow).toEqual({ x: 0, y: 0 });
    await expect(map).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("img", { name: /QR code/ })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText("Mode", { exact: true })).toBeInViewport({ ratio: 1 });
  });
}

test("/screen for a code with no hive says so instead of connecting forever", async ({ page }) => {
  await page.goto("/screen/ZZZZ");
  await expect(page.getByRole("heading", { name: "Hive not found" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Connecting…")).toHaveCount(0);
});
