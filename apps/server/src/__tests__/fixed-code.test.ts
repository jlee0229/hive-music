import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Regression test for docs/PROTOCOL-REQUESTS.md R-5 finding #1: a *bare* POST /rooms (no code in the
 * body — what the host UI's "create room" actually sends) must still resolve to ROOM_FIXED_CODE when
 * one is set, exactly like an explicit {code: ROOM_FIXED_CODE} call. Before the fix, a bare call always
 * took the random-code path, so a restart or redeploy handed the host a fresh code and the QR already
 * on screen (and any player mid-scan) died — the one thing ROOM_FIXED_CODE exists to prevent
 * (docs/02-protocol.md §6: "a fixed code survives a restart").
 */
const PORT = 27080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
let proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], {
    env: { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "DEMO" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
afterAll(() => proc.kill());

async function postRooms(body: unknown): Promise<{ status: number; body: { code?: string; hostKey?: string; error?: string } }> {
  const res = await fetch(`${BASE}/rooms`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe("ROOM_FIXED_CODE applies to a bare POST /rooms", () => {
  test("a bare call (what the host UI actually sends) resolves to the fixed code, not a random one", async () => {
    const { status, body } = await postRooms({});
    expect(status).toBe(200);
    expect(body.code).toBe("DEMO");
    expect(typeof body.hostKey).toBe("string");
  });

  test("repeated bare calls are idempotent: same code, same hostKey (simulates a host reload)", async () => {
    const first = await postRooms({});
    const second = await postRooms({});
    expect(second.body.code).toBe(first.body.code);
    expect(second.body.hostKey).toBe(first.body.hostKey);
  });

  test("a bare call and an explicit {code: ROOM_FIXED_CODE} call resolve to the same room", async () => {
    const bare = await postRooms({});
    const explicit = await postRooms({ code: "DEMO" });
    expect(explicit.body.code).toBe(bare.body.code);
    expect(explicit.body.hostKey).toBe(bare.body.hostKey);
  });

  test("a non-matching, non-existent requested code is still rejected", async () => {
    const { status, body } = await postRooms({ code: "NOPE" });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });
});
