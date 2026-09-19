import { afterAll, beforeAll, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@hive/protocol";

/** Boots the real server as a child process on a random port and checks /health + CORS. */
const PORT = 20080 + Math.floor(Math.random() * 900);
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "http://localhost:3000" }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

test("GET /health reports the protocol version with CORS headers", async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(typeof body.serverTime).toBe("number");
});
