import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Audit SG-01, end to end over HTTP against the real server process — including a real restart.
 * FIXTURES_DIR points at an empty temp dir and HOST_KEY_SECRET is unset, so this exercises the
 * production path: the signing secret is created beside the tracks on first boot and read back by
 * the next process.
 */
const PORT = 24080 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const fixtures = mkdtempSync(join(tmpdir(), "hive-hostkey-"));
let proc: ReturnType<typeof Bun.spawn> | null = null;

async function boot() {
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "", FIXTURES_DIR: fixtures };
  delete env.HOST_KEY_SECRET;
  proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}
async function stop() {
  proc?.kill();
  await proc?.exited;
  proc = null;
}
afterAll(async () => {
  await stop();
  rmSync(fixtures, { recursive: true, force: true });
});

async function postRooms(body: unknown) {
  const res = await fetch(`${BASE}/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { code?: string; hostKey?: string; joinUrl?: string; restored?: boolean; error?: string } };
}

describe("SG-01 over HTTP", () => {
  test("create → guests cannot claim → host reload echoes → restart → host restores, guests still cannot", async () => {
    await boot();
    const created = await postRooms({});
    expect(created.status).toBe(200);
    const { code, hostKey } = created.body as { code: string; hostKey: string };
    expect(created.body.joinUrl).toContain(`/j/${code}`);
    expect(created.body.restored).toBeUndefined();

    // What the deployed host page sends when it has no key — and what any guest can send.
    const guest = await postRooms({ code });
    expect(guest.status).toBe(403);
    expect(guest.body).toEqual({ error: "NOT_HOST" });
    expect((await postRooms({ code, hostKey: "guess" })).status).toBe(403);
    // Parity probe S4: a body that is not the documented shape is a 400 — it used to be a 500, and for
    // one wave was quietly read as "no code, no key". Either way it never yields a key.
    for (const bad of [{ code, hostKey: 12345 }, { code: 123 }, { code: ["A"] }, { code: "" }, { code: "X".repeat(9) }, { code, hostKey: "k".repeat(65) }, "a string", 42, [1]]) {
      const res = await postRooms(bad);
      expect(`${JSON.stringify(bad).slice(0, 40)} → ${res.status}`).toBe(`${JSON.stringify(bad).slice(0, 40)} → 400`);
      expect(res.body).toEqual({ error: "bad request" });
    }

    const reload = await postRooms({ code, hostKey });
    expect(reload.status).toBe(200);
    expect(reload.body).toMatchObject({ code, hostKey });

    // Bodies that are not objects must not crash the handler (a JSON `null` used to throw → 500).
    const weird = await fetch(`${BASE}/rooms`, { method: "POST", body: "null" });
    expect(weird.status).toBe(200);

    await stop();
    await boot(); // every room is gone; the signing secret was persisted beside the tracks

    expect((await fetch(`${BASE}/rooms/${code}`)).status).toBe(404);
    expect((await postRooms({ code })).status).toBe(400);
    expect((await postRooms({ code, hostKey: "guess" })).status).toBe(400);
    expect((await fetch(`${BASE}/rooms/${code}`)).status).toBe(404); // failed attempts created nothing

    const restored = await postRooms({ code, hostKey });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ code, hostKey, restored: true });
    expect((await fetch(`${BASE}/rooms/${code}`)).status).toBe(200);
    expect((await postRooms({ code })).status).toBe(403);
  }, 30_000);
});
