/** What a waiting guest is told when the host is not there any more. */
import { test, expect } from "./fixtures";
import { connectAsHost } from "./helpers/host-driver";

// transport stopped: the guest waits on the Ready screen.
test.use({ mockScenario: "join.json" });

test("the wait line says the host has gone, and recovers when they are back", async ({ page }) => {
  await page.goto("/j/BZQ7");
  await page.getByPlaceholder("Your name").fill("Patient");
  await page.getByRole("button", { name: "Tap to join" }).click();
  await expect(page.getByText("Waiting for the host to start")).toBeVisible({ timeout: 10_000 });

  // A host arrives, then their phone locks / their tab closes.
  const host = await connectAsHost("BZQ7");
  await host.waitForRoomState();
  await expect(page.getByText("Waiting for the host to start")).toBeVisible();
  host.close();
  await expect(page.getByText("Waiting for the host to come back")).toBeVisible({ timeout: 10_000 });

  const back = await connectAsHost("BZQ7");
  await expect(page.getByText("Waiting for the host to start")).toBeVisible({ timeout: 10_000 });
  back.close();
});
