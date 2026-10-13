import { ROLE_COLORS } from "@hive/protocol";
import { test, expect } from "./fixtures";

/**
 * The planner's two-part labels ("drums + bass": two phones covering a four-stem song) in the one
 * host view that prints a label: the Players drawer. The colour is the role's, and the longer label
 * must not push the row apart on a small phone.
 */
test.use({ mockScenario: "join.json" }); // two phones, ORCHESTRA, four stems

const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

test("host players drawer: two-part labels keep the role colour and fit at 320 px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/h/BZQ7");
  await page.getByRole("button", { name: "Players", exact: true }).click();

  const maya = page.getByRole("button", { name: /Maya/ });
  const jon = page.getByRole("button", { name: /Jon/ });
  await expect(maya).toContainText("drums + bass", { timeout: 10_000 });
  await expect(jon).toContainText("vocals + other");
  await expect(maya.locator("span").first()).toHaveCSS("background-color", rgb(ROLE_COLORS.drums));
  await expect(jon.locator("span").first()).toHaveCSS("background-color", rgb(ROLE_COLORS.vocals));

  for (const row of [maya, jon]) {
    const box = (await row.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    // the number at the end of the row stays on one line (it used to wrap to "+45 / ms")
    expect((await row.locator("span.font-mono").boundingBox())!.height).toBeLessThan(20);
  }
});
