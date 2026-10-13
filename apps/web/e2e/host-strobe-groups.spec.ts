import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * The Strobe "Groups" row follows the planner: it never runs more groups than there are phones in
 * the room, so the row offers only what the room can fill and highlights what is actually running —
 * while the count the host asked for stays as it is (the page never rewrites it by itself).
 */
test.use({ mockScenario: "party-12.json" });

/** Snapshots as the page sees them: Strobe with `groups` requested, and only the first `speakers` scripted phones. */
async function strobeRoom(page: Page, speakers: number, groups: number) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.type === "ROOM_STATE") {
        const scripted = Object.keys(msg.room.clients).filter((id) => id.startsWith("mock-")).sort();
        for (const id of scripted.slice(speakers)) delete msg.room.clients[id];
        msg.room.mode = { kind: "STROBE", params: { groups } };
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

test("host strobe: 8 groups requested with 5 phones in the room — chips 2-5 only, 5 highlighted, and nothing is sent until the host taps", async ({ page }) => {
  const sent: Array<{ type: string; mode?: string; params?: { groups?: number } }> = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      const text = String(f.payload);
      if (text.includes('"SET_MODE"')) sent.push(JSON.parse(text));
    }),
  );
  await strobeRoom(page, 5, 8);
  await page.goto("/h/BZQ7");

  const row = page.getByTestId("strobe-groups");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByRole("button")).toHaveText(["2", "3", "4", "5"]);
  await expect(row.getByRole("button", { name: "5", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByRole("button", { pressed: true })).toHaveCount(1);

  await page.waitForTimeout(1200); // a couple of snapshots: the page must not "correct" the request itself
  expect(sent).toEqual([]);

  await row.getByRole("button", { name: "3", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ type: "SET_MODE", mode: "STROBE", params: { groups: 3 } });
});

test("host strobe: with one phone there is no Groups row (one phone cannot trade off with itself)", async ({ page }) => {
  await strobeRoom(page, 1, 4);
  await page.goto("/h/BZQ7");
  await expect(page.getByRole("button", { name: "1/4", exact: true })).toBeVisible({ timeout: 10_000 }); // the Beat row is there
  await expect(page.getByTestId("strobe-groups")).toHaveCount(0);
  await expect(page.getByText("Groups", { exact: true })).toHaveCount(0);
});
