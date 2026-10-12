/**
 * PROTO-12 · the mock must behave like apps/server wherever the e2e suite can tell the difference.
 * Each test names a divergence that `scripts/parity-probe.ts` measured between the two before the mock was
 * brought into line (the probe is the cross-check against the real server; these pin the mock's side).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LEAD_MS, PROTOCOL_VERSION, TRACK_ADVANCE_LEAD_MS } from "../constants";
import { startMockServer } from "../mock-server";
import { TrackLibraryResponseSchema } from "../rest";
import type { ScenePlan } from "../scene";
import { currentScene, loopRestartZero, nextInRotation, nextScene } from "../timeline";
import { Raw, device, sleep, testPort } from "./harness";

const PORT = testPort(6);
const API = `http://localhost:${PORT}`;
let mock: ReturnType<typeof startMockServer>;
beforeAll(async () => {
  mock = startMockServer({ port: PORT, quiet: true, scenario: { players: [] } });
  await mock.ready;
});
afterAll(() => mock.stop());

async function joined(clientId: string, kind: "host" | "player" | "viewer", port = PORT, hostKey = mock.hostKey) {
  const s = new Raw(port);
  await s.open();
  s.send({ type: "JOIN", clientId, roomCode: "BZQ7", kind, plays: kind === "player", hostKey: kind === "host" ? hostKey : undefined, device, protocolVersion: PROTOCOL_VERSION });
  await s.next("WELCOME");
  return s;
}
const post = (path: string, body?: unknown) => fetch(`${API}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

describe("mock ↔ server parity: REST", () => {
  test("POST /rooms refuses a code that is not the room, as the server refuses an unknown code", async () => {
    expect((await post("/rooms", { code: "ZZ99" })).status).toBe(400); // was 200 with the scenario room's hostKey
    expect((await post("/rooms", { code: "bzq7" })).status).toBe(200);
    expect((await post("/rooms")).status).toBe(200);
  });

  test("GET /tracks: sorted like the server, urls follow the request origin, beatOffsetSec is carried", async () => {
    const res = TrackLibraryResponseSchema.parse(await fetch(`http://127.0.0.1:${PORT}/tracks`).then((r) => r.json()));
    expect(res.tracks.length).toBeGreaterThan(0);
    // Order is (meta.order, title); `order` is not on the wire, and a developer's local library may
    // pin a real song to the top. The generated fixtures never set it, so among those the order is
    // by title on any machine — and they must come out contiguous, after anything pinned.
    const titles = res.tracks.filter((t) => t.generated).map((t) => t.title);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b))); // was filesystem scan order
    for (const t of res.tracks) for (const u of Object.values(t.urls)) expect(u.startsWith(`http://127.0.0.1:${PORT}/audio/`)).toBe(true); // was hard-coded localhost
    expect((await post("/tracks")).status).toBe(501); // was 200 with the library: any method matched
  });

  test("POST /rooms/:code/vibe validates the room and the prompt", async () => {
    expect((await post("/rooms/ZZ99/vibe", { prompt: "calm" })).status).toBe(404); // was 200, and it changed THIS room
    expect((await post("/rooms/BZQ7/vibe", { prompt: "" })).status).toBe(400); // was 200 "untitled vibe"
    expect((await post("/rooms/BZQ7/vibe", {})).status).toBe(400);
    const ok = await post("/rooms/BZQ7/vibe", { prompt: "calm then explode" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { scenePlan: ScenePlan }).scenePlan.scenes[0]!.atTrackSec).toBe(0);
  });
});

describe("mock ↔ server parity: the socket", () => {
  test("a socket that has not joined is told nothing", async () => {
    const lurker = new Raw(PORT);
    await lurker.open();
    const host = await joined("par-host-0001", "host");
    host.send({ type: "SET_MODE", mode: "WAVE", params: {} });
    await host.next("ROOM_STATE", (m) => m.room.mode.kind === "WAVE");
    await sleep(150);
    expect(lurker.inbox).toEqual([]); // it used to receive every ROOM_STATE: subscribed on open, not on JOIN
    lurker.close(); host.close();
  });

  test("the user agent is never stored or broadcast", async () => {
    const host = await joined("par-host-0002", "host");
    const state = await host.next("ROOM_STATE", (m) => !!m.room.clients["par-host-0002"]);
    expect(state.room.clients["par-host-0002"]!.device).toEqual({ ...device, userAgent: "" });
    host.close();
  });

  test("SET_TRACK with an unknown id is an error and leaves the music alone", async () => {
    const host = await joined("par-host-0003", "host");
    const first = mock.room.track!.id;
    host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
    await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
    host.send({ type: "SET_TRACK", trackId: "no-such-track" });
    expect((await host.next("ERROR", (m) => m.code === "NO_TRACK")).message).toContain("no-such-track");
    await sleep(100);
    expect(mock.room.transport.state).toBe("playing"); // it used to stop playback, silently
    expect(mock.room.track!.id).toBe(first);
    host.send({ type: "TRANSPORT", action: "PAUSE" });
    host.close();
  });

  // Flip to test() together with REQUIRE_AUDIO_READY_FOR_CALIBRATION in mock-server.ts (PROTO-15): the
  // real server already behaves this way; the mock is held back by the stub engine never announcing.
  test.failing("calibration: a speaker that has not announced AUDIO_READY gets no slot (server parity, blocked on the stub engine)", async () => {
    const host = await joined("par-host-0014", "host");
    const loading = await joined("par-loading-1", "player");
    try {
      host.send({ type: "CALIBRATION_START", referenceClientId: "par-host-0014" });
      const plan = await host.next("CALIBRATION_PLAN");
      host.send({ type: "CALIBRATION_CANCEL" });
      await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");
      expect(plan.order).not.toContain("par-loading-1");
    } finally {
      host.close(); loading.close();
    }
  });

  test("calibration: only connected speakers are scheduled, in join order, and only the reference may report", async () => {
    const host = await joined("par-host-0004", "host");
    const ready = await joined("par-ready-001", "player");
    const gone = await joined("par-gone-0001", "player");
    ready.send({ type: "AUDIO_READY", trackId: mock.room.track!.id });
    gone.close();
    await host.next("ROOM_STATE", (m) => m.room.clients["par-gone-0001"]?.connected === false && m.room.clients["par-ready-001"]?.audioReadyTrackId === mock.room.track!.id);

    host.send({ type: "CALIBRATION_START", referenceClientId: "par-host-0004" });
    const plan = await host.next("CALIBRATION_PLAN");
    expect(plan.order).toContain("par-ready-001");
    expect(plan.order).not.toContain("par-gone-0001"); // a phone that is not there used to get a slot of dead air

    // a player reporting for itself: ignored (it used to finish the run and write the offset)
    ready.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "par-ready-001", residualMs: 50, confidence: 0.9 }] });
    await sleep(300);
    expect(mock.room.calibration.state).toBe("countdown");
    expect(mock.room.clients["par-ready-001"]!.calibratedOffsetMs).toBeNull();

    host.send({ type: "CALIBRATION_REPORT", measurements: [{ clientId: "par-ready-001", residualMs: 5, confidence: 0.9 }] });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "done");
    expect(mock.room.clients["par-ready-001"]!.calibratedOffsetMs).toBe(25 + 5); // desktop-chrome table row
    host.send({ type: "CALIBRATION_CANCEL" });
    await host.next("ROOM_STATE", (m) => m.room.calibration.state === "idle");
    host.close(); ready.close();
  });

  test("kicking a host removes its authority along with its record", async () => {
    const host = await joined("par-host-0005", "host");
    const second = await joined("par-host-0006", "host");
    await host.next("ROOM_STATE", (m) => m.room.hostClientIds.includes("par-host-0006"));
    host.send({ type: "KICK", clientId: "par-host-0006" });
    const after = await host.next("ROOM_STATE", (m) => !m.room.clients["par-host-0006"]);
    expect(after.room.hostClientIds).not.toContain("par-host-0006"); // it used to stay listed for ever
    host.close(); second.close();
  });
});

describe("mock ↔ server parity: the timeline keeps moving (the mock used to have no timers at all)", () => {
  test("end of track: the playlist advances with TRACK_ADVANCE_LEAD_MS, and the vibe plan is dropped", async () => {
    const port = testPort(7);
    const own = startMockServer({ port, quiet: true, scenario: { players: [] } });
    await own.ready;
    try {
      const res = TrackLibraryResponseSchema.parse(await fetch(`http://localhost:${port}/tracks`).then((r) => r.json()));
      const host = await joined("par-host-0007", "host", port, own.hostKey);
      const first = own.room.track!;
      await fetch(`http://localhost:${port}/rooms/BZQ7/vibe`, { method: "POST", body: JSON.stringify({ prompt: "calm" }) });
      host.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec: first.durationSec - 1 });
      const t0 = performance.timeOrigin + performance.now();
      if (res.tracks.length > 1) {
        const next = await host.next("ROOM_STATE", (m) => m.room.track?.id !== first.id, 4000);
        expect(next.room.transport.state).toBe("playing");
        expect(next.room.scenePlan).toBeNull();
        const zero = (next.room.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero;
        // the old end (≈ t0 + LEAD + 1 s) plus the breather for phones to fetch the next song
        expect(zero - t0).toBeGreaterThan(TRACK_ADVANCE_LEAD_MS + 1000);
        expect(zero - t0).toBeLessThan(TRACK_ADVANCE_LEAD_MS + 1000 + LEAD_MS + 500);
        expect(next.room.clients["par-host-0007"]).toBeDefined();
      } else {
        const looped = await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing" && m.room.transport.serverTimeAtTrackZero > t0, 4000);
        expect(looped.room.track!.id).toBe(first.id);
      }
      host.close();
    } finally {
      own.stop();
    }
  }, 15_000);

  test("a single-track library restarts that track seamlessly at its end", async () => {
    const port = testPort(8);
    const own = startMockServer({ port, quiet: true, fixturesDir: `${import.meta.dir}/no-such-fixtures`, scenario: { players: [] } });
    await own.ready;
    try {
      const host = await joined("par-host-0008", "host", port, own.hostKey);
      expect(own.room.track!.id).toBe("synthetic-60s");
      host.send({ type: "TRANSPORT", action: "SEEK", trackTimeSec: 59 });
      const seeked = await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
      const zero0 = (seeked.room.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero;
      host.forget();
      const looped = await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing" && m.room.transport.serverTimeAtTrackZero !== zero0, 4000);
      // the new track zero is exactly the old end: phones schedule the restart on the boundary itself
      expect((looped.room.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero).toBeCloseTo(zero0 + 60_000, 3);
      expect(looped.room.track!.id).toBe("synthetic-60s");
      host.close();
    } finally {
      own.stop();
    }
  }, 15_000);

  test("scene plan: PLAY applies the scene at the position, and the next boundary fires with applyAtServerTime", async () => {
    const port = testPort(9);
    const own = startMockServer({
      port, quiet: true,
      scenario: {
        players: [{ name: "Solo" }],
        scenePlan: { prompt: "p", scenes: [{ atTrackSec: 0, mode: "CHOIR", params: {}, note: "open" }, { atTrackSec: 2, mode: "STROBE", params: { groups: 2 }, note: "drop" }] },
      },
    });
    await own.ready;
    try {
      const host = await joined("par-host-0009", "host", port, own.hostKey);
      host.send({ type: "TRANSPORT", action: "PLAY", trackTimeSec: 0 });
      const playing = await host.next("ROOM_STATE", (m) => m.room.transport.state === "playing");
      expect(playing.room.mode.kind).toBe("CHOIR"); // the scene at 0, applied at once
      const zero = (playing.room.transport as { serverTimeAtTrackZero: number }).serverTimeAtTrackZero;
      const fired = await host.next("ROOM_STATE", (m) => m.room.mode.kind === "STROBE", 4000);
      const solo = Object.values(fired.room.clients).find((c) => c.plays)!;
      expect(solo.assignment!.applyAtServerTime).toBeCloseTo(zero + 2000, 3); // every phone ramps on the boundary
      // a manual mode change clears the plan and nothing fires afterwards
      host.send({ type: "SET_MODE", mode: "UNISON", params: {} });
      await host.next("ROOM_STATE", (m) => m.room.mode.kind === "UNISON" && m.room.scenePlan === null);
      host.close();
    } finally {
      own.stop();
    }
  }, 15_000);
});

describe("timeline.ts (pure)", () => {
  const lib = [{ id: "a" }, { id: "syn", generated: true }, { id: "b" }, { id: "c" }];
  test("nextInRotation: real songs only, wrapping, and null when there is nowhere to go", () => {
    expect(nextInRotation(lib, "a")!.id).toBe("b");
    expect(nextInRotation(lib, "c")!.id).toBe("a");
    expect(nextInRotation(lib, "syn")!.id).toBe("a"); // a synthetic track hands over to the first real one
    expect(nextInRotation(lib, "gone")!.id).toBe("a");
    expect(nextInRotation([{ id: "only" }], "only")).toBeNull();
    expect(nextInRotation([{ id: "s1", generated: true }, { id: "s2", generated: true }], "s1")!.id).toBe("s2");
    expect(nextInRotation([], "x")).toBeNull();
  });

  test("loopRestartZero: the old end when it is still ahead, a fresh lead when it is not", () => {
    expect(loopRestartZero(10_600, 10_000)).toBe(10_600);
    expect(loopRestartZero(10_050, 10_000)).toBe(10_000 + LEAD_MS);
    expect(loopRestartZero(5_000, 10_000)).toBe(10_000 + LEAD_MS); // a SEEK past the end
  });

  test("nextScene / currentScene at the boundaries", () => {
    const plan: ScenePlan = { prompt: "p", source: "rules", createdAtServerTime: 0, scenes: [{ atTrackSec: 0, mode: "UNISON", params: {}, note: "a" }, { atTrackSec: 10, mode: "WAVE", params: {}, note: "b" }] };
    const playing = { state: "playing" as const, serverTimeAtTrackZero: 1000 };
    expect(currentScene(plan, playing, 500)!.mode).toBe("UNISON"); // in the lead-in: track time clamps to 0
    expect(currentScene(plan, playing, 10_999)!.mode).toBe("UNISON");
    expect(currentScene(plan, playing, 11_000)!.mode).toBe("WAVE"); // exactly on the boundary
    expect(nextScene(plan, playing, 500)).toMatchObject({ boundaryServerTime: 11_000, fireAtServerTime: 11_000 - LEAD_MS });
    expect(nextScene(plan, playing, 11_000)).toBeNull(); // nothing strictly ahead
    expect(nextScene(plan, { state: "paused", trackTimeAtPause: 3 }, 0)).toBeNull();
    expect(currentScene(plan, { state: "paused", trackTimeAtPause: 12 }, 0)!.mode).toBe("WAVE");
    expect(nextScene(null, playing, 0)).toBeNull();
    expect(currentScene(null, playing, 0)).toBeNull();
  });
});
