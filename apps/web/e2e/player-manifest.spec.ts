/** The web app manifest and its icons: what "Add to Home Screen" installs. */
import { test, expect } from "./fixtures";

type ManifestIcon = { src: string; type: string; sizes: string; purpose?: string };

test("the manifest is installable and every icon it names is real and the size it claims", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");

  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const manifest = (await res.json()) as { name: string; short_name: string; start_url: string; scope: string; display: string; background_color: string; theme_color: string; icons: ManifestIcon[] };

  expect(manifest).toMatchObject({ name: "HiveMusic", short_name: "HiveMusic", start_url: "/", scope: "/", display: "standalone" });
  // The page's own theme colour and the manifest's must agree, or the status bar flashes on launch.
  expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe(manifest.theme_color);
  expect(manifest.background_color).toBe(manifest.theme_color);

  // Chrome needs a 192 and a 512; Android's adaptive launcher needs a maskable one or it shrinks
  // the icon into a white circle.
  const sizes = (purpose: string) => manifest.icons.filter((i) => (i.purpose ?? "any").split(" ").includes(purpose)).map((i) => i.sizes);
  expect(sizes("any")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(sizes("maskable")).toEqual(expect.arrayContaining(["192x192", "512x512"]));

  for (const icon of manifest.icons) {
    const png = await request.get(icon.src);
    expect(png.ok(), icon.src).toBe(true);
    const bytes = await png.body();
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    // IHDR: width and height are the two big-endian uint32s at offset 16.
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
  }
});
