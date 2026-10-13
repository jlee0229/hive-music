import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * The REAL-STACK party suite: real @hive/server, the web app as production serves it (`next build`
 * + `next start`), the real Web Audio engine, one browser context per phone. Everything the default
 * e2e config (mock server + stub engine) cannot see: sound, sync, reconnects, uploads, scale.
 *
 *   bun run e2e:party                 # from the repo root: builds the web app, runs every scenario
 *   bun run e2e:party 01-basic        # one scenario file
 *
 * Needs `bun run fixtures` once (the synthetic WAVs). Env:
 *
 *   HIVE_SERVER_PORT   port the suite starts the real server on           (default 8910)
 *   PW_WEB_PORT        port for the production web server it starts       (default 3210)
 *   PW_BASE_URL        use an already-running web server instead (it must have been BUILT with
 *                      NEXT_PUBLIC_API_URL=http://localhost:$HIVE_SERVER_PORT and
 *                      NEXT_PUBLIC_WS_URL=ws://localhost:$HIVE_SERVER_PORT/ws, engine not stubbed)
 *   PARTY_SKIP_BUILD=1 reuse the existing `.next` (same caveat: it must have been built for this port)
 *   PARTY_OUT_DIR      where metrics JSON, the log and screenshots go     (default test-results/party)
 *   PARTY_SOAK_GUESTS  guests in the scale soak                           (default 30)
 *   PARTY_SOAK_SEC     seconds per soak mode                              (default 90)
 *   BUN_BIN            absolute path to bun when it is not on PATH
 *   PW_CHROMIUM_PATH   browser binary (defaults as in playwright.config.ts)
 *
 * `next build` writes `.next`: never run this while `next dev` or the default e2e suite is running
 * in apps/web. Each test starts its own server process on a private temp fixtures dir (the repo's
 * library is never touched) and kills it afterwards. The spec files are `*.party.ts`, so the
 * default config never picks them up.
 */
const SERVER_PORT = Number(process.env.HIVE_SERVER_PORT ?? 8910);
const WEB_PORT = Number(process.env.PW_WEB_PORT ?? 3210);
const CI_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(CI_CHROMIUM) ? CI_CHROMIUM : undefined);
const next = "node ../../node_modules/next/dist/bin/next";

export default defineConfig({
  testDir: "./e2e/party",
  testMatch: "**/*.party.ts",
  timeout: 15 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/party-artifacts",
  use: {
    baseURL: process.env.PW_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  webServer: process.env.PW_BASE_URL
    ? undefined
    : {
        command: process.env.PARTY_SKIP_BUILD === "1" ? `${next} start -p ${WEB_PORT}` : `${next} build && ${next} start -p ${WEB_PORT}`,
        url: `http://localhost:${WEB_PORT}`,
        reuseExistingServer: true,
        timeout: 300_000,
        env: {
          NEXT_PUBLIC_API_URL: `http://localhost:${SERVER_PORT}`,
          NEXT_PUBLIC_WS_URL: `ws://localhost:${SERVER_PORT}/ws`,
          NEXT_PUBLIC_HIVE_ENGINE: "", // the real engine, whatever .env.local says
        },
      },
});
