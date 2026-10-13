/**
 * SG-03 · the persisted client id is scoped by role.
 *
 * Every tab of one browser shares localStorage, and host, player and `/screen` all kept their identity
 * under `hive:clientId:<room>`. Opening the join page on the phone that hosts took over the host's own
 * slot; an id first used by `/screen` came back as a silent viewer when that browser later joined as a
 * player. Players keep the original key (nothing to migrate); hosts and viewers get their own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHiveClient, createStubClient } from "../index";
import { nullAudioEngine } from "../client";
import { persistedClientId } from "../transport";

const g = globalThis as unknown as { localStorage?: unknown };
let hadStorage = false;
let previous: unknown;
let store: Map<string, string>;

beforeEach(() => {
  hadStorage = "localStorage" in g;
  previous = g.localStorage;
  store = new Map();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  if (hadStorage) g.localStorage = previous;
  else delete g.localStorage;
});

const urls = { wsUrl: "ws://localhost:1/ws", apiUrl: "http://localhost:1", roomCode: "BZQ7" };

describe("SG-03 · role-scoped client ids", () => {
  test("host, player and viewer built in one browser get three different ids, each under its own key", () => {
    const host = createHiveClient({ ...urls, kind: "host", plays: false }, { createAudioEngine: () => nullAudioEngine() });
    const player = createHiveClient({ ...urls, kind: "player", plays: true }, { createAudioEngine: () => nullAudioEngine() });
    const viewer = createHiveClient({ ...urls, kind: "viewer", plays: false }, { createAudioEngine: () => nullAudioEngine() });
    expect(new Set([host.clientId, player.clientId, viewer.clientId]).size).toBe(3);
    expect(Object.fromEntries(store)).toEqual({
      "hive:clientId:BZQ7:host": host.clientId,
      "hive:clientId:BZQ7": player.clientId,
      "hive:clientId:BZQ7:screen": viewer.clientId,
    });
    // and each role finds its own id again (a reload, a second tab of the same page)
    expect(createStubClient({ ...urls, kind: "host", plays: false }).clientId).toBe(host.clientId);
    expect(createStubClient({ ...urls, kind: "player", plays: true }).clientId).toBe(player.clientId);
    expect(createStubClient({ ...urls, kind: "viewer", plays: false }).clientId).toBe(viewer.clientId);
  });

  test("a player's id is exactly what it was before: same key, an existing value is kept", () => {
    store.set("hive:clientId:BZQ7", "existing-player-id-0001");
    expect(createHiveClient({ ...urls, kind: "player", plays: true }, { createAudioEngine: () => nullAudioEngine() }).clientId).toBe("existing-player-id-0001");
    expect(persistedClientId("BZQ7")).toBe("existing-player-id-0001"); // the one-argument form is the player's
    // the join tab opened on the hosting phone no longer takes the host's slot
    const host = createHiveClient({ ...urls, kind: "host", plays: false }, { createAudioEngine: () => nullAudioEngine() });
    expect(host.clientId).not.toBe("existing-player-id-0001");
  });

  test("ids are per room, and an explicit clientId still wins and is not persisted", () => {
    const a = persistedClientId("AAAA", "host");
    const b = persistedClientId("BBBB", "host");
    expect(a).not.toBe(b);
    const before = store.size;
    const explicit = createHiveClient({ ...urls, kind: "host", plays: false, clientId: "explicit-host-0001" }, { createAudioEngine: () => nullAudioEngine() });
    expect(explicit.clientId).toBe("explicit-host-0001");
    expect(store.size).toBe(before);
  });

  test("storage that throws (private mode) still yields a usable id", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const id = persistedClientId("BZQ7", "viewer");
    expect(id.length).toBeGreaterThanOrEqual(8);
  });
});
