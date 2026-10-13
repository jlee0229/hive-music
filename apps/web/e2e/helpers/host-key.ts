/**
 * The host key in e2e. Since the server stopped handing the key to anyone who knows the room code
 * (and the mock mirrors it), a browser can only host `/h/CODE` if it holds the key — which a real
 * host gets from "Host a hive" on the landing page. Specs that open `/h/BZQ7` directly are that
 * phone: the base fixture (e2e/fixtures.ts) seeds the key for them. A spec about a browser that is
 * NOT the host opts out with `test.use({ seedHostKey: false })`.
 */
import type { BrowserContext, Page } from "@playwright/test";

/** The mock server's single room and its key (packages/protocol/src/mock-server.ts). */
export const MOCK_ROOM = "BZQ7";
export const MOCK_HOST_KEY = "mock-host-key";

/**
 * Stores the key as the landing page would have, once per browser profile: the init script runs on
 * every navigation, so it leaves a marker and never re-seeds — a page that later drops or replaces
 * the key keeps what it wrote across reloads.
 */
export async function seedHostKey(target: BrowserContext | Page, code: string = MOCK_ROOM, key: string = MOCK_HOST_KEY): Promise<void> {
  await target.addInitScript(
    ([c, k]) => {
      try {
        const mark = `hive:e2e:hostKeySeeded:${c}`;
        if (localStorage.getItem(mark)) return;
        localStorage.setItem(mark, "1");
        localStorage.setItem(`hive:hostKey:${c}`, k!);
      } catch {
        /* storage blocked in this test: nothing to seed */
      }
    },
    [code, key],
  );
}
