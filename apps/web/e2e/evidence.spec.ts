/**
 * Not a check — captures the PNG screenshots gate tables cite as evidence. Run manually per gate,
 * e.g. `bunx playwright test e2e/evidence.spec.ts -g F0`.
 */
import path from "node:path";
import { test, expect } from "./fixtures";

const OUT = path.resolve(__dirname, "../../../evidence/frontend");

test.use({ mockScenario: "party-12.json" });

test("F0 evidence: /diag screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/diag");
  await page.getByLabel("Room code").fill("BZQ7");
  await page.getByRole("button", { name: "Tap to connect" }).click();
  await expect(page.getByText("ready", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: path.join(OUT, "F0-diag.png") });
});
