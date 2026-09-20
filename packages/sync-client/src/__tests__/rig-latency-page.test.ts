/**
 * `rig/latency.html` is a dependency-free page a phone opens once, so nothing bundles or type-checks it —
 * which means the one thing that can silently rot is the thing it exists to produce: a line that pastes
 * into `STARTER_LATENCY_TABLE_MS`. The page hard-codes the family names, and the table is keyed by
 * `BrowserFamily`; rename or add a family and the page keeps emitting a key nobody can paste.
 *
 * So this test reads the page as text and checks the two couplings that matter. It cannot check that the
 * numbers are right — only a phone can — and it does not try to.
 */
import { describe, expect, test } from "bun:test";
import { BROWSER_FAMILIES, STARTER_LATENCY_TABLE_MS } from "@hive/protocol";

const PAGE = `${import.meta.dir}/../../rig/latency.html`;
const html = await Bun.file(PAGE).text();

describe("rig/latency.html", () => {
  test("every family it can emit is a real BrowserFamily", () => {
    const fn = html.slice(html.indexOf("function browserFamily()"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const returned = [...body.matchAll(/return "([a-z-]+)"/g)].map((m) => m[1]!);
    expect(returned.length).toBeGreaterThanOrEqual(BROWSER_FAMILIES.length);
    for (const family of returned) expect(BROWSER_FAMILIES).toContain(family as (typeof BROWSER_FAMILIES)[number]);
    // and it can produce every family, not just some: a family it never emits is a row nobody can measure
    for (const family of BROWSER_FAMILIES) expect(returned).toContain(family);
  });

  test("the pasteable line is shaped like the table it pastes into", () => {
    // The table source looks like `  "ios-safari": 60,` — the page builds the same shape.
    expect(html).toContain('`  "${browserFamily()}": ${rowMs === null ? "null" : rowMs},`');
    // A browser that reports nothing must emit `null`, never 0: null falls through to the phone's own
    // outputLatency and then to acoustic calibration, while 0 claims the device has no output latency.
    expect(html).toContain('? Math.round(interactive.outputLatency * 1000)\n    : null;');
    // the table itself uses exactly that convention, which is what makes the paste safe
    expect(STARTER_LATENCY_TABLE_MS.other).toBeNull();
    expect(Object.values(STARTER_LATENCY_TABLE_MS).some((v) => v === 0)).toBe(false);
  });

  test("it measures the latencyHint the engine actually uses", () => {
    // The engine builds its context with latencyHint "interactive" (audio.ts). A table row measured on a
    // "playback" context would be wrong by the gap between them — 40 ms on Chromium 141.
    expect(html).toContain('const HINTS = ["interactive", "playback"];');
    expect(html).toContain("interactive.outputLatency");
  });
});
