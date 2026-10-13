import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/** Audit SG-06 / SG-14: POST /rooms and GET /rooms/:code have per-caller budgets. */
const PORT = 26080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], {
    env: { ...process.env, PORT: String(PORT), ROOM_FIXED_CODE: "", ROOMS_PER_MINUTE: "5", LOOKUPS_PER_MINUTE: "12", HOST_KEY_SECRET: "rate-limit-test-secret-0123456789abcdef" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

describe("POST /rooms rate limit", () => {
  test("the 6th creation inside a minute from one address is 429, and creates nothing; other routes are unaffected", async () => {
    const statuses: number[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" });
      statuses.push(res.status);
      const body = (await res.json()) as { code?: string; error?: string };
      if (body.code) codes.push(body.code);
      else expect(body).toEqual({ error: "rate_limited" });
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    expect(new Set(codes).size).toBe(5);
    expect((await fetch(`${BASE}/health`)).status).toBe(200);
    expect((await fetch(`${BASE}/rooms/${codes[0]}`)).status).toBe(200);
  });
});

describe("GET /rooms/:code rate limit (SG-14)", () => {
  test("a sweep of the code space is cut off: the 13th lookup inside a minute is 429 whether or not the room exists", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) statuses.push((await fetch(`${BASE}/rooms/${i % 2 ? "ZZZZ" : "QQQQ"}`)).status);
    // one lookup was already spent by the test above
    expect(statuses).toEqual([...Array(11).fill(404), ...Array(5).fill(429)]);
    expect((await fetch(`${BASE}/health`)).status).toBe(200);
  });
});
