import { test as base } from "@playwright/test";
import { startMock, type MockHandle } from "./helpers/mock";

export const test = base.extend<{ mockScenario: string; mock: MockHandle }>({
  mockScenario: ["party-12.json", { option: true }],
  mock: [
    async ({ mockScenario }, use) => {
      const handle = await startMock(mockScenario);
      await use(handle);
      await handle.stop();
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
