// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { decideProtocolGuard } from "./protocolVersionGuard";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("decideProtocolGuard", () => {
  test("same version, or a server that could not be asked: nothing to do", () => {
    const s = memoryStorage();
    expect(decideProtocolGuard(4, 4, () => s)).toBe("ok");
    expect(decideProtocolGuard(null, 4, () => s)).toBe("ok");
    expect(s.data.size).toBe(0);
  });

  test("a mismatch reloads once; the reloaded page, still mismatched, gets the banner", () => {
    const s = memoryStorage(); // sessionStorage survives the reload
    expect(decideProtocolGuard(5, 4, () => s)).toBe("reload");
    expect(decideProtocolGuard(5, 4, () => s)).toBe("banner");
    expect(decideProtocolGuard(5, 4, () => s)).toBe("banner");
  });

  test("the one reload is per bundle version: a newer bundle that is still behind may reload once more", () => {
    const s = memoryStorage();
    expect(decideProtocolGuard(6, 4, () => s)).toBe("reload");
    expect(decideProtocolGuard(6, 5, () => s)).toBe("reload");
    expect(decideProtocolGuard(6, 5, () => s)).toBe("banner");
  });

  test("storage that throws on access (Safari, all cookies blocked) never reloads — it used to reload on every load", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    // Every page load starts from scratch; each one must end on the banner, not on another reload.
    for (let load = 0; load < 5; load++) expect(decideProtocolGuard(5, 4, blocked)).toBe("banner");
  });

  test("storage whose writes throw (quota 0 in private mode) or are silently dropped never reloads either", () => {
    const quota = { getItem: () => null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
    const dropped = { getItem: () => null, setItem: () => {} };
    for (let load = 0; load < 5; load++) {
      expect(decideProtocolGuard(5, 4, () => quota)).toBe("banner");
      expect(decideProtocolGuard(5, 4, () => dropped)).toBe("banner");
    }
  });
});
