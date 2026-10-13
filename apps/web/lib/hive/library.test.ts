// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { classifyRemove, removeErrorText } from "./library";
import { getLibraryKey } from "./storage";

describe("classifyRemove / removeErrorText", () => {
  test("a 2xx is a removal, with nothing to say", () => {
    expect(classifyRemove(200, { ok: true } as never)).toBe("removed");
    expect(classifyRemove(204, null)).toBe("removed");
    expect(removeErrorText("removed")).toBeNull();
  });
  test("409 in_use: the song is on in some hive", () => {
    expect(classifyRemove(409, { error: "in_use" })).toBe("in_use");
    expect(removeErrorText("in_use")).toBe("That song is playing — pick another first.");
  });
  test("not yours and not there read the same (the server does not say which either)", () => {
    expect(classifyRemove(403, { error: "not_owner" })).toBe("not_allowed");
    expect(classifyRemove(404, null)).toBe("not_allowed");
    expect(removeErrorText("not_allowed")).not.toMatch(/owner|403|404/);
  });
  test("no answer or a server error is worth another try", () => {
    expect(classifyRemove(0, null)).toBe("failed");
    expect(classifyRemove(500, null)).toBe("failed");
    expect(removeErrorText("failed")).toMatch(/try again/);
  });
});

describe("getLibraryKey", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const install = (storage: unknown) => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  const memory = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };

  test("made once — 32 random bytes as base64url, 43 characters — then the same key every time", () => {
    const store = memory();
    install(store);
    const key = getLibraryKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.data.get("hive:libraryKey")).toBe(key);
    expect(getLibraryKey()).toBe(key);
    expect(getLibraryKey()).toBe(key);
    expect(store.data.size).toBe(1);
  });

  test("another browser gets another key", () => {
    install(memory());
    const a = getLibraryKey();
    install(memory());
    const b = getLibraryKey();
    expect(a).not.toBe(b);
  });

  test("a stored value that is not a key (wrong alphabet, too short) is replaced, not sent", () => {
    for (const junk of ["short", "has spaces and = signs ====", "<script>".repeat(4)]) {
      const store = memory();
      store.data.set("hive:libraryKey", junk);
      install(store);
      const key = getLibraryKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(store.data.get("hive:libraryKey")).toBe(key);
    }
  });

  test("storage blocked: one key for as long as the page lives, instead of a new one per call", () => {
    install({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const key = getLibraryKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getLibraryKey()).toBe(key);
  });
});
