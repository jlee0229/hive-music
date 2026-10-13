import { test as base, expect } from "@playwright/test";
import { Party, startServer, makeFixturesDir, OUT_DIR, type SeedTrack, type ServerHandle } from "./harness";

export interface ServerControl {
  current: ServerHandle;
  /** Kill the process and start a new one on the same port and fixtures dir. Returns ms the port was dark. */
  restart(downMs?: number): Promise<number>;
  kill(): Promise<void>;
  start(): Promise<void>;
}

/**
 * `server`: a fresh real server per test, on a private fixtures dir. `party`: the harness, closed
 * (and its report written) when the test ends, pass or fail.
 */
export interface LibraryOption {
  /** Extra one-stem tracks to put in the server's library before it boots. */
  seed?: SeedTrack[];
  /** false = start without the synthetic pair (a library of only `seed`); a list = only those synthetic ids. */
  synthetic?: boolean | string[];
}

export const test = base.extend<{ server: ServerControl; party: Party; library: LibraryOption }>({
  /** What the server's private library holds: test.use({ library: { seed: [...], synthetic: false } }). */
  library: [{}, { option: true }],
  server: async ({ library }, use) => {
    const dir = makeFixturesDir(library.seed ?? [], { synthetic: library.synthetic });
    const ctl: ServerControl = {
      current: await startServer(dir),
      async kill() {
        await ctl.current.kill();
      },
      async start() {
        ctl.current = await startServer(dir);
      },
      async restart(downMs = 0) {
        const t0 = performance.now();
        await ctl.current.kill();
        if (downMs) await new Promise((r) => setTimeout(r, downMs));
        ctl.current = await startServer(dir);
        return performance.now() - t0;
      },
    };
    await use(ctl);
    await ctl.current.kill();
  },
  party: async ({ browser, server, baseURL }, use, testInfo) => {
    void server; // the party needs it up first
    const scenario = testInfo.titlePath.at(-1)!.split(":")[0]!.trim().replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
    const party = new Party(browser, baseURL!, scenario);
    await use(party);
    const body = party.report();
    await testInfo.attach("party-report", { body: JSON.stringify(body, null, 2), contentType: "application/json" });
    await party.close();
  },
});

export { expect, OUT_DIR };
