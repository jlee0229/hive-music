import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, parseServerMessage, type ServerMessage } from "@hive/protocol";

/**
 * Audit SG-09. POST /rooms/:code/vibe had no credential: anyone who knew a room code could rewrite
 * that room's mode timeline (host-only state) and spend an LLM call per request, as fast as they
 * could send them. Two servers: the default (a keyless request is still accepted, because the
 * shipped web client sends none — but a presented key is checked, and there are budgets) and
 * VIBE_REQUIRE_HOST_KEY=1 (what production should run once the client sends the key).
 */
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };

function server(port: number, extraEnv: Record<string, string>) {
  const base = `http://localhost:${port}`;
  let proc: ReturnType<typeof Bun.spawn>;
  return {
    base,
    async start() {
      const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), ROOM_FIXED_CODE: "", HOST_KEY_SECRET: "vibe-auth-test-secret-0123456789abcdef", ...extraEnv };
      delete env.ANTHROPIC_API_KEY; // rules fallback only: these tests must never make a real LLM call
      proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env, stdout: "ignore", stderr: "ignore" });
      for (let i = 0; i < 80; i++) {
        try {
          if ((await fetch(`${base}/health`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("server did not start");
    },
    stop: () => proc.kill(),
    room: async () => (await (await fetch(`${base}/rooms`, { method: "POST", body: "{}" })).json()) as { code: string; hostKey: string },
    vibe: (code: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/rooms/${code}/vibe`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    /** Joins as a guest and resolves with the room's scenePlan prompt as the next ROOM_STATE reports it. */
    async scenePrompt(code: string): Promise<string | null> {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      const state = new Promise<Extract<ServerMessage, { type: "ROOM_STATE" }>>((resolve) => {
        ws.onmessage = (e) => {
          const m = parseServerMessage(String(e.data));
          if (m?.type === "ROOM_STATE") resolve(m);
        };
      });
      ws.send(JSON.stringify({ type: "JOIN", clientId: `watch-${crypto.randomUUID().slice(0, 12)}`, roomCode: code, kind: "viewer", plays: false, device, protocolVersion: PROTOCOL_VERSION }));
      const prompt = (await state).room.scenePlan?.prompt ?? null;
      ws.close();
      return prompt;
    },
  };
}

describe("SG-09: default server — presented keys are checked, requests are budgeted", () => {
  const s = server(28080 + Math.floor(Math.random() * 400), { VIBES_PER_MINUTE: "6" });
  beforeAll(() => s.start());
  afterAll(() => s.stop());

  test("a wrong key (header or body) is refused and changes nothing; the right key works; keyless is still accepted for the current client", async () => {
    const room = await s.room();
    const other = await s.room();

    expect((await s.vibe(room.code, { prompt: "rave" }, { authorization: "Bearer wrong" })).status).toBe(403);
    expect((await s.vibe(room.code, { prompt: "rave", hostKey: other.hostKey })).status).toBe(403); // a real key, for another room
    expect((await s.vibe(room.code, { prompt: "rave" }, { authorization: "Basic abc" })).status).toBe(403);
    expect(await s.scenePrompt(room.code)).toBeNull();

    const ok = await s.vibe(room.code, { prompt: "calm then build" }, { authorization: `Bearer ${room.hostKey}` });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { scenePlan: { prompt: string } }).scenePlan.prompt).toBe("calm then build");
    expect(await s.scenePrompt(room.code)).toBe("calm then build");

    expect((await s.vibe(room.code, { prompt: "body key", hostKey: room.hostKey })).status).toBe(200);
    expect((await s.vibe(room.code, { prompt: "no key at all" })).status).toBe(200); // compatibility window (see VIBE_REQUIRE_HOST_KEY)

    // 7th request this minute from this address (three of the six before it were refusals — they count too)
    const limited = await s.vibe(room.code, { prompt: "again" }, { authorization: `Bearer ${room.hostKey}` });
    expect(limited.status).toBe(429);
    expect(await s.scenePrompt(room.code)).toBe("no key at all");
  });
});

describe("SG-09: VIBE_REQUIRE_HOST_KEY=1 — the timeline is host-only", () => {
  const s = server(28500 + Math.floor(Math.random() * 400), { VIBE_REQUIRE_HOST_KEY: "1" });
  beforeAll(() => s.start());
  afterAll(() => s.stop());

  test("no key → 403 and the room is untouched; the host's key → 200", async () => {
    const room = await s.room();
    const anon = await s.vibe(room.code, { prompt: "strobe everything" });
    expect(anon.status).toBe(403);
    expect(await anon.json()).toEqual({ error: "NOT_HOST" });
    expect(await s.scenePrompt(room.code)).toBeNull();

    expect((await s.vibe(room.code, { prompt: "wave" }, { authorization: `Bearer ${room.hostKey}` })).status).toBe(200);
    expect(await s.scenePrompt(room.code)).toBe("wave");
  });

  test("bad input is still answered plainly: unknown room 404, bad prompt 400, oversized body 413, non-JSON 400", async () => {
    const room = await s.room();
    const auth = { authorization: `Bearer ${room.hostKey}` };
    expect((await s.vibe("ZZZZ", { prompt: "x" }, auth)).status).toBe(404);
    expect((await s.vibe(room.code, { prompt: "" }, auth)).status).toBe(400);
    expect((await s.vibe(room.code, { prompt: "p".repeat(501) }, auth)).status).toBe(400);
    expect((await s.vibe(room.code, "not json", auth)).status).toBe(400);
    expect((await s.vibe(room.code, { prompt: "x", padding: "y".repeat(40_000) }, auth)).status).toBe(413);
    const rooms = await fetch(`${s.base}/rooms`, { method: "POST", body: JSON.stringify({ code: "y".repeat(40_000) }) });
    expect(rooms.status).toBe(413);
  });
});
