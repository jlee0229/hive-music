import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * The suite is self-contained: `node ../../node_modules/@playwright/test/cli.js test` starts its
 * own `next dev` (stub engine, pointed at the mock port) and each test starts the mock it needs.
 *
 *   HIVE_MOCK_PORT   mock server port                      (default 8080)
 *   PW_WEB_PORT      port for the web server we start      (default 3100)
 *   PW_BASE_URL      use an already-running web server instead of starting one
 *   PW_CHROMIUM_PATH browser binary; defaults to the CI image's, else Playwright's bundled one
 *   PW_MANUAL=1      include e2e/manual/** (needs the real server; see those files)
 *   BUN_BIN          absolute path to bun when it is not on PATH
 *
 * Run it with node, not `bun x playwright`: Bun's child-process spawn of the browser fails on
 * Windows ("spawn UNKNOWN").
 */
const MOCK_PORT = Number(process.env.HIVE_MOCK_PORT ?? 8080);
const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3100);
const CI_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(CI_CHROMIUM) ? CI_CHROMIUM : undefined);

export default defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.PW_MANUAL === "1" ? [] : ["**/manual/**"],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PW_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PW_BASE_URL
    ? undefined
    : {
        command: `node ../../node_modules/next/dist/bin/next dev -p ${WEB_PORT}`,
        url: `http://localhost:${WEB_PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        // Process env wins over .env.local in Next, so a developer's local API settings never leak in.
        env: {
          NEXT_PUBLIC_API_URL: `http://localhost:${MOCK_PORT}`,
          NEXT_PUBLIC_WS_URL: `ws://localhost:${MOCK_PORT}/ws`,
          NEXT_PUBLIC_HIVE_ENGINE: "stub",
        },
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : {},
      },
    },
  ],
});
