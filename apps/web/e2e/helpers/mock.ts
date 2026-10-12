/**
 * Spawns the @hive/protocol mock server for a Playwright test on HIVE_MOCK_PORT (default 8080) —
 * the same port playwright.config.ts bakes into the web server it starts (NEXT_PUBLIC_WS_URL /
 * NEXT_PUBLIC_API_URL), so the app talks to whichever scenario the test starts. One mock at a time;
 * tests run serially (see playwright.config.ts). The port is an env var because 8080 is routinely
 * taken on a dev machine, and because several checkouts must be able to run the suite at once.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MOCK_SERVER = path.join(REPO_ROOT, "packages/protocol/src/mock-server.ts");
export const MOCK_PORT = Number(process.env.HIVE_MOCK_PORT ?? 8080);
export const MOCK_URL = `http://localhost:${MOCK_PORT}`;
/** Absolute path when `bun` is not on PATH (a fresh Windows shell after a winget install). */
const BUN_BIN = process.env.BUN_BIN ?? "bun";

export interface MockHandle {
  process: ChildProcess;
  stop: () => Promise<void>;
}

export async function startMock(scenarioName: string): Promise<MockHandle> {
  const scenarioPath = path.join(REPO_ROOT, "apps/web/mocks/scenarios", scenarioName);
  const child = spawn(BUN_BIN, ["run", MOCK_SERVER, "--scenario", scenarioPath], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: "pipe",
  });
  let ready = false;
  child.stdout?.on("data", (d) => {
    if (String(d).includes("listening on")) ready = true;
  });
  const deadline = Date.now() + 10_000;
  while (!ready && Date.now() < deadline) {
    try {
      const res = await fetch(`${MOCK_URL}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) throw new Error("mock server did not become ready in time");
  return {
    process: child,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(resolve, 2000);
      }),
  };
}
