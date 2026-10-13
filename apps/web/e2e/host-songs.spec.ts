import { MOCK_URL } from "./helpers/mock";
import { test, expect } from "./fixtures";

const CORS = { "access-control-allow-origin": "*" };

/** n seconds of silence as a real WAV file (8-bit mono 8 kHz: small on disk, long on the clock). */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n, 0x80);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  return buf;
}

test.describe("picking a song", () => {
  test.use({ mockScenario: "party-12.json" });

  test("host songs: tapping the song that is already playing keeps the music going (no SET_TRACK)", async ({ page }) => {
    const sent: string[] = [];
    page.on("websocket", (ws) => ws.on("framesent", (f) => sent.push(String(f.payload))));

    await page.goto("/h/BZQ7");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    const current = page.getByRole("button", { name: /Synthetic 60/ });
    await expect(current).toContainText("playing");
    await current.click();

    await expect(page.getByPlaceholder("Search the library")).toHaveCount(0); // drawer closed
    await page.waitForTimeout(1200); // two snapshot periods: a stop would have arrived by now
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(sent.filter((m) => m.includes('"SET_TRACK"'))).toEqual([]);
  });
});

test.describe("the list", () => {
  test.use({ mockScenario: "join.json" });

  test("host songs: a search with no matches says so; a stopped song is 'up next', not 'now playing'; an uploaded song is not '1 parts · 213s'", async ({ page }) => {
    await page.route(`${MOCK_URL}/tracks`, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { tracks: Array<Record<string, unknown>> };
      body.tracks.push({ id: "upload-abc12345", title: "My Uploaded Song", durationSec: 213.4, stems: ["mix"], urls: { mix: `${MOCK_URL}/audio/x/mix.wav` } });
      await route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });
    });
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Songs", exact: true }).click();

    await expect(page.getByRole("button", { name: /Synthetic 60/ })).toContainText("4 parts · 1:00 · up next");
    await expect(page.getByText("now playing")).toHaveCount(0);
    const uploaded = page.getByRole("button", { name: /My Uploaded Song/ });
    await expect(uploaded).toContainText("3:33");
    await expect(uploaded).not.toContainText("parts");

    await page.getByPlaceholder("Search the library").fill("zzzz-no-such-song");
    await expect(page.getByText("No songs match.")).toBeVisible();
  });
});

test.describe("upload", () => {
  test.use({ mockScenario: "join.json" });

  test("host upload: a file that is not audio gets a plain sentence", async ({ page }) => {
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("these are not the bytes you are looking for") });
    await expect(page.locator(".fixed").getByRole("alert")).toHaveText(/couldn't read that file as audio/, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "+ Upload a song" })).toBeEnabled();
  });

  test("host upload: a song over the 10-minute limit is refused from its header, before it is decoded into memory", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __decodes: number };
      w.__decodes = 0;
      const original = AudioContext.prototype.decodeAudioData;
      AudioContext.prototype.decodeAudioData = function (this: AudioContext, ...args: Parameters<typeof original>) {
        w.__decodes++;
        return original.apply(this, args);
      } as typeof original;
    });
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "hour-long mix.wav", mimeType: "audio/wav", buffer: silentWav(615) });

    await expect(page.locator(".fixed").getByRole("alert")).toHaveText("that song is 10:15 long — the limit is 10 minutes", { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __decodes: number }).__decodes)).toBe(0);
  });

  test("host upload: a refused host key is explained in words, and a good upload shows progress then returns to idle", async ({ page }) => {
    let status = 403;
    let posted = 0;
    const authHeaders: string[] = [];
    await page.route(`${MOCK_URL}/tracks`, async (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
      }
      if (route.request().method() !== "POST") return route.continue();
      posted++;
      authHeaders.push(route.request().headers()["authorization"] ?? "");
      if (status === 403) {
        return route.fulfill({ status: 403, contentType: "application/json", headers: CORS, body: JSON.stringify({ error: "NOT_HOST", message: "a valid hostKey is required to upload a track" }) });
      }
      await new Promise((r) => setTimeout(r, 600)); // long enough to see the "Uploading…" state
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        headers: CORS,
        body: JSON.stringify({ track: { id: "two-seconds-1234abcd", title: "two seconds", durationSec: 2, stems: ["mix"], urls: {} } }),
      });
    });
    await page.goto("/h/BZQ7");
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    const input = page.locator('input[type="file"]');
    const alert = page.locator(".fixed").getByRole("alert");

    await input.setInputFiles({ name: "two seconds.wav", mimeType: "audio/wav", buffer: silentWav(2) });
    await expect(alert).toHaveText("this phone can't add songs right now — reload the page and try again", { timeout: 15_000 });
    await expect(alert).not.toContainText("NOT_HOST");

    status = 201;
    await input.setInputFiles({ name: "two seconds.wav", mimeType: "audio/wav", buffer: silentWav(2) });
    await expect(page.getByRole("button", { name: /Uploading… \d+%/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "+ Upload a song" })).toBeEnabled({ timeout: 15_000 });
    await expect(alert).toHaveCount(0);
    expect(posted).toBe(2);
    // The key travels as a Bearer header, which the server checks before reading the (large) body.
    expect(authHeaders).toEqual(["Bearer mock-host-key", "Bearer mock-host-key"]);
  });
});
