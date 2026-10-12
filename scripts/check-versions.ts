#!/usr/bin/env bun
// One Bun version everywhere. The repo pins Bun in four places; this fails when they disagree.
//   bun scripts/check-versions.ts        (CI runs it; `bun run check` runs it first)
// To move to a new Bun: change all four, run `bun install` with that Bun, commit bun.lock too.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function capture(rel: string, re: RegExp): string | null {
  return read(rel).match(re)?.[1] ?? null;
}

const pins: Array<[where: string, version: string | null]> = [
  ["package.json  packageManager", capture("package.json", /"packageManager":\s*"bun@([^"]+)"/)],
  ["infra/Dockerfile  ARG BUN_VERSION", capture("infra/Dockerfile", /^ARG BUN_VERSION=(\S+)/m)],
  [".github/workflows/ci.yml  env.BUN_VERSION", capture(".github/workflows/ci.yml", /^\s*BUN_VERSION:\s*"?([0-9][^"\s]*)"?/m)],
  [".github/workflows/deploy-fly.yml  env.BUN_VERSION", capture(".github/workflows/deploy-fly.yml", /^\s*BUN_VERSION:\s*"?([0-9][^"\s]*)"?/m)],
];

for (const [where, version] of pins) console.log(`${(version ?? "NOT FOUND").padEnd(10)} ${where}`);

const versions = new Set(pins.map(([, v]) => v));
if (versions.has(null) || versions.size !== 1) {
  console.error("\ncheck-versions: FAIL: the Bun version pins above must all exist and be identical.");
  process.exit(1);
}

const pinned = [...versions][0]!;
if (Bun.version !== pinned) {
  // Not an error: a newer local Bun usually works. But the lockfile and CI are judged against the pin.
  console.warn(`\ncheck-versions: note: you are running Bun ${Bun.version}; the repo pins ${pinned}.`);
}
console.log("\ncheck-versions: ok");
