// apps/web typechecks with types: ["node"]; pull in bun:test for this file only (run: `bun test ./lib`).
/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { classifyHostClaim } from "./host-claim";

describe("classifyHostClaim", () => {
  test("a key in a 2xx answer is the key", () => {
    expect(classifyHostClaim(200, { code: "BZQ7", hostKey: "k", joinUrl: "x" })).toEqual({ kind: "ok", code: "BZQ7", hostKey: "k" });
    expect(classifyHostClaim(201, { code: "BZQ7", hostKey: "k" }).kind).toBe("ok");
  });

  test("today's server: an unknown room code (400) means the hive is gone, not that the server is down", () => {
    expect(classifyHostClaim(400, { error: "unknown room code" })).toEqual({ kind: "ended" });
    expect(classifyHostClaim(404, null)).toEqual({ kind: "ended" });
  });

  test("a server that refuses to hand out the key — by status or by leaving it out — means it is hosted elsewhere", () => {
    expect(classifyHostClaim(403, { error: "NOT_HOST" })).toEqual({ kind: "elsewhere" });
    expect(classifyHostClaim(409, null)).toEqual({ kind: "elsewhere" });
    expect(classifyHostClaim(200, { code: "BZQ7", exists: true })).toEqual({ kind: "elsewhere" });
    expect(classifyHostClaim(200, { code: "BZQ7", hostKey: "" })).toEqual({ kind: "elsewhere" });
    expect(classifyHostClaim(200, null)).toEqual({ kind: "elsewhere" });
  });

  test("no answer, or a server error, is worth a retry", () => {
    expect(classifyHostClaim(null, null)).toEqual({ kind: "unreachable" });
    expect(classifyHostClaim(500, null)).toEqual({ kind: "unreachable" });
    expect(classifyHostClaim(502, "<html>")).toEqual({ kind: "unreachable" });
  });
});
