import { connectAsHost } from "./helpers/host-driver";
import { test, expect } from "./fixtures";

test.use({ mockScenario: "join.json" });

const STALE = "stale-key-from-before-the-restart";

test("F2: a stale hostKey on a hive nobody hosts yet lands on the stage as host, without looping", async ({ page }) => {
  // A room re-created server-side (a restart of a fixed-code room, an idle timeout) has a fresh
  // hostKey while this tab still holds the old one. Both servers accept a `kind: "host"` JOIN while
  // `hostClientIds` is empty (R-16), so there is no demotion to recover from any more: the page is
  // simply the host. It therefore keeps the key it had — the old expectation that the stored key gets
  // replaced described the pre-R-16 detour through POST /rooms and is deliberately gone (what that
  // leaves broken — REST calls that check the key, i.e. uploads — is finding HOST-04).
  await page.addInitScript(
    ([code, key]) => {
      localStorage.setItem(`hive:hostKey:${code}`, key!);
    },
    ["BZQ7", STALE],
  );

  await page.goto("/h/BZQ7");
  await expect(page.getByText("Synthetic 60")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Join QR code" })).toBeVisible();

  // Fully functional as host afterwards -- not just visually present.
  await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
});

test("F2: a stale hostKey on a hive someone else is hosting never strands the phone on a spinner", async ({ page }) => {
  // Another host holds the room, so this JOIN is demoted to a plain player. What happens next is the
  // server's call (today POST /rooms hands the real key back and the page re-joins as host; the
  // host-key redesign will refuse) — either way the page must end somewhere usable: the stage, as a
  // working host, or the "hosted on another phone" screen with its exits.
  const realHost = await connectAsHost("BZQ7");
  await page.addInitScript(
    ([code, key]) => {
      if (!sessionStorage.getItem("seeded")) localStorage.setItem(`hive:hostKey:${code}`, key!);
      sessionStorage.setItem("seeded", "1");
    },
    ["BZQ7", STALE],
  );

  await page.goto("/h/BZQ7");
  const stage = page.getByRole("link", { name: "Join QR code" });
  const elsewhere = page.getByRole("heading", { name: "This hive is hosted on another phone" });
  await expect(stage.or(elsewhere)).toBeVisible({ timeout: 10_000 });

  if (await elsewhere.isVisible()) {
    await expect(page.getByRole("link", { name: "Join it instead" })).toHaveAttribute("href", "/j/BZQ7");
    await expect(page.getByRole("link", { name: "Back home" })).toHaveAttribute("href", "/");
  } else {
    expect(await page.evaluate(() => localStorage.getItem("hive:hostKey:BZQ7"))).not.toBe(STALE);
    await page.getByRole("button", { name: /Start the hive|Start anyway/ }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
  }
  realHost.close();
});
