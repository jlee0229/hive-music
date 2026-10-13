import { test as base } from "@playwright/test";
import { seedHostKey } from "./helpers/host-key";
import { startMock, type MockHandle } from "./helpers/mock";

export const test = base.extend<{ mockScenario: string; mock: MockHandle; seedHostKey: boolean; hostKeySeed: void }>({
  mockScenario: ["party-12.json", { option: true }],
  mock: [
    async ({ mockScenario }, use) => {
      const handle = await startMock(mockScenario);
      await use(handle);
      await handle.stop();
    },
    { auto: true },
  ],
  /**
   * The test's browser is the phone that created the hive: it holds the mock room's host key, as it
   * would after "Host a hive" (see helpers/host-key.ts). `test.use({ seedHostKey: false })` for a
   * spec about a browser that is not the host. Contexts a spec creates itself with
   * `browser.newContext()` are not covered — call `seedHostKey(context)` on those.
   */
  seedHostKey: [true, { option: true }],
  hostKeySeed: [
    async ({ context, seedHostKey: wanted }, use) => {
      if (wanted) await seedHostKey(context);
      await use();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
