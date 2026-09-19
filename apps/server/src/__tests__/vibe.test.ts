import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ScenePlanSchema, VibeResponseSchema, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { normalizeScenes } from "../vibe/normalize";
import { rulesFallback } from "../vibe/rules";
import { directScene } from "../vibe/director";

const FIXTURES_DIR = `${import.meta.dir}/../../../../fixtures`;

async function loadSyntheticMeta() {
  return (await Bun.file(`${FIXTURES_DIR}/tracks/synthetic-60s/meta.json`).json()) as {
    durationSec: number;
    dropSec: number;
    energy: number[];
    title: string;
    stems: string[];
    bpm: number;
  };
}

describe("vibe rules fallback (unit)", () => {
  test("10/10 prompts produce a schema-valid plan on synthetic-60s", async () => {
    const meta = await loadSyntheticMeta();
    const prompts = [
      "calm, then explode at the drop",
      "chill and intimate",
      "spread the band across the room",
      "make it wide, left and right",
      "let the beat roll across the room",
      "strobe rave energy",
      "just vibe",
      "build then change halfway through",
      "acoustic and soft",
      "party pulse",
    ];
    for (const prompt of prompts) {
      const scenes = normalizeScenes(rulesFallback(prompt, meta), meta.durationSec);
      const plan = ScenePlanSchema.parse({ prompt, source: "rules", createdAtServerTime: 0, scenes });
      expect(plan.scenes[0]!.atTrackSec).toBe(0);
    }
  });

  test('"calm, then explode at the drop" is calm first, then WAVE/STROBE at dropSec', async () => {
    const meta = await loadSyntheticMeta();
    const scenes = normalizeScenes(rulesFallback("calm, then explode at the drop", meta), meta.durationSec);
    expect(scenes[0]!.mode).toBe("UNISON");
    expect(scenes[0]!.atTrackSec).toBe(0);
    const dropScene = scenes.find((s) => s.atTrackSec === meta.dropSec);
    expect(dropScene).toBeDefined();
    expect(["WAVE", "STROBE"]).toContain(dropScene!.mode);
  });

  test("strobe/flash/rave keywords pick STROBE at the drop instead of WAVE", async () => {
    const meta = await loadSyntheticMeta();
    const scenes = normalizeScenes(rulesFallback("strobe rave energy at the drop", meta), meta.durationSec);
    const dropScene = scenes.find((s) => s.atTrackSec === meta.dropSec);
    expect(dropScene!.mode).toBe("STROBE");
  });

  test("normalizeScenes prepends UNISON@0 when the first scene isn't at 0, and merges scenes closer than 2s", () => {
    const scenes = normalizeScenes(
      [
        { atTrackSec: 5, mode: "ORCHESTRA", params: {}, note: "a" },
        { atTrackSec: 6, mode: "WAVE", params: {}, note: "b" }, // within 2s of the previous — merged, keep the later
        { atTrackSec: 100, mode: "STROBE", params: {}, note: "c" }, // at/beyond durationSec — dropped
      ],
      60,
    );
    expect(scenes[0]).toEqual({ atTrackSec: 0, mode: "UNISON", params: {}, note: "open" });
    expect(scenes).toHaveLength(2);
    expect(scenes[1]!.mode).toBe("WAVE");
  });
});

describe("directScene (no ANTHROPIC_API_KEY in this environment)", () => {
  test("falls back to rules and returns a schema-valid plan", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const meta = await loadSyntheticMeta();
      const plan = await directScene(
        "calm, then explode at the drop",
        { title: meta.title, durationSec: meta.durationSec, stems: meta.stems, bpm: meta.bpm, dropSec: meta.dropSec, energy: meta.energy },
        3,
        "UNISON",
        performance.timeOrigin + performance.now(),
      );
      expect(plan.source).toBe("rules");
      expect(() => ScenePlanSchema.parse(plan)).not.toThrow();
      expect(plan.scenes[0]!.mode).toBe("UNISON");
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

// ---- HTTP integration: POST /rooms/:code/vibe end to end -------------------------------------------
describe("POST /rooms/:code/vibe (HTTP integration, key unset)", () => {
  const PORT = 24080 + Math.floor(Math.random() * 900);
  const BASE = `http://localhost:${PORT}`;
  const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
  let proc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    const env: Record<string, string | undefined> = { ...process.env, PORT: String(PORT), CORS_ORIGIN: "*", ROOM_FIXED_CODE: "" };
    delete env.ANTHROPIC_API_KEY;
    proc = Bun.spawn(["bun", `${import.meta.dir}/../index.ts`], { env, stdout: "ignore", stderr: "inherit" });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  });
  afterAll(() => proc.kill());

  test("returns a schema-valid, calm-first plan with the drop scene at dropSec", async () => {
    const { code, hostKey } = (await fetch(`${BASE}/rooms`, { method: "POST", body: "{}" }).then((r) => r.json())) as { code: string; hostKey: string };

    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const inbox: ServerMessage[] = [];
    ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
    const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
    const waitFor = (pred: (m: ServerMessage) => boolean, timeoutMs = 3000) =>
      new Promise<ServerMessage>((resolve, reject) => {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        const iv = setInterval(() => {
          const m = inbox.find(pred);
          if (m) {
            clearInterval(iv);
            clearTimeout(t);
            resolve(m);
          }
        }, 20);
      });

    send({ type: "JOIN", clientId: "host-vibe-0001", roomCode: code, kind: "host", plays: false, hostKey, device, protocolVersion: PROTOCOL_VERSION });
    await waitFor((m) => m.type === "WELCOME");
    send({ type: "SET_TRACK", trackId: "synthetic-60s" });
    await waitFor((m) => m.type === "ROOM_STATE" && m.room.track?.id === "synthetic-60s");

    const res = await fetch(`${BASE}/rooms/${code}/vibe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "calm, then explode at the drop" }),
    });
    expect(res.status).toBe(200);
    const body = VibeResponseSchema.parse(await res.json());
    expect(body.scenePlan.source).toBe("rules"); // no ANTHROPIC_API_KEY in this environment
    expect(body.scenePlan.scenes[0]!.atTrackSec).toBe(0);
    expect(body.scenePlan.scenes[0]!.mode).toBe("UNISON");
    const dropScene = body.scenePlan.scenes.find((s) => s.atTrackSec === 30);
    expect(dropScene).toBeDefined();
    expect(["WAVE", "STROBE"]).toContain(dropScene!.mode);

    // the room broadcasts the accepted plan
    const state = await waitFor((m) => m.type === "ROOM_STATE" && m.room.scenePlan?.prompt === "calm, then explode at the drop");
    if (state.type === "ROOM_STATE") expect(state.room.scenePlan!.source).toBe("rules");

    ws.close();
  });
});
