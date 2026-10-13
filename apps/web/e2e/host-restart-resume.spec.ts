import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/**
 * PARTY-02: a server restart re-creates the room empty (no song, stopped, UNISON). The host page
 * puts the show back by itself — and only then. The three scenarios drop every socket 8 s in:
 * restart-wipe.json and restart-wipe-paused.json re-create the room empty as apps/server does,
 * restart-blip.json keeps it (an ordinary network blip).
 */
test.setTimeout(60_000);

type Room = {
  createdAtServerTime: number;
  track: { id: string } | null;
  mode: { kind: string; params: Record<string, unknown> };
  transport: { state: string; serverTimeAtTrackZero?: number };
};
interface Wire {
  /** Hive sockets opened so far: 1 before the drop, 2 after the reconnect. */
  sockets: number;
  sent: Array<{ socket: number; msg: { type: string } & Record<string, unknown> }>;
  states: Array<{ socket: number; room: Room }>;
}

/** Every frame of the page's hive socket(s), tagged with which socket carried it. */
function tap(page: Page): Wire {
  const wire: Wire = { sockets: 0, sent: [], states: [] };
  page.on("websocket", (ws) => {
    if (!new URL(ws.url()).pathname.endsWith("/ws")) return; // not next dev's own HMR socket
    const socket = ++wire.sockets;
    ws.on("framesent", (f) => {
      try {
        wire.sent.push({ socket, msg: JSON.parse(String(f.payload)) });
      } catch {
        /* not JSON */
      }
    });
    ws.on("framereceived", (f) => {
      try {
        const msg = JSON.parse(String(f.payload));
        if (msg.type === "ROOM_STATE") wire.states.push({ socket, room: msg.room });
      } catch {
        /* not JSON */
      }
    });
  });
  return wire;
}

/** The host commands that change the show, as sent on the socket opened after the drop. */
const SHOW_COMMANDS = ["SET_TRACK", "SET_MODE", "TRANSPORT", "CALIBRATION_START"];
const showCommandsAfterDrop = (wire: Wire) => wire.sent.filter((s) => s.socket >= 2 && SHOW_COMMANDS.includes(s.msg.type)).map((s) => s.msg);
const lastRoom = (wire: Wire) => wire.states.at(-1)!.room;

async function rideOutTheDrop(page: Page) {
  await expect(page.getByText("Reconnecting to the hive")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Reconnecting to the hive")).not.toBeVisible({ timeout: 10_000 });
}

test.describe("a restart that re-creates the room empty, mid-song", () => {
  test.use({ mockScenario: "restart-wipe.json" });

  test("the music comes back by itself: same song, same mode, the position it would have reached, no tuning", async ({ page }) => {
    const wire = tap(page);
    await page.goto("/h/BZQ7");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    const before = lastRoom(wire);
    expect(before.transport.state).toBe("playing");

    await rideOutTheDrop(page);

    // Nobody touches the page.
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Strobe", exact: true })).toHaveAttribute("aria-pressed", "true");
    const sent = showCommandsAfterDrop(wire);
    expect(sent.map((m) => m.type)).toEqual(["SET_TRACK", "SET_MODE", "TRANSPORT"]);
    expect(sent[0]).toMatchObject({ trackId: "synthetic-60s" });
    expect(sent[1]).toMatchObject({ mode: "STROBE", params: { groups: 3, beatsPerSwitch: 2 } });
    expect(sent[2]).toMatchObject({ action: "PLAY" });
    expect(sent[2]!.trackTimeSec as number).toBeGreaterThan(7);

    await expect.poll(() => lastRoom(wire).transport.state).toBe("playing");
    const after = lastRoom(wire);
    expect(after.createdAtServerTime, "the mock really re-created the room").not.toBe(before.createdAtServerTime);
    expect(after.track?.id).toBe("synthetic-60s");
    expect(after.mode).toEqual(before.mode);
    // The old timeline, not a new one: every phone is where it would have been without the restart.
    expect(Math.abs(after.transport.serverTimeAtTrackZero! - before.transport.serverTimeAtTrackZero!)).toBeLessThan(250);

    // Invisible: no toast, no tuning screen, and the first-song auto-pick never answers the empty room.
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("Tuning moment")).toHaveCount(0);
    await page.waitForTimeout(4000); // past the auto-pick's 3 s re-send window
    expect(showCommandsAfterDrop(wire).map((m) => m.type)).toEqual(["SET_TRACK", "SET_MODE", "TRANSPORT"]);
    expect(lastRoom(wire).track?.id).toBe("synthetic-60s");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  });
});

test.describe("a restart that re-creates the room empty, while paused", () => {
  test.use({ mockScenario: "restart-wipe-paused.json" });

  test("the song and the mode come back; the music never starts by itself", async ({ page }) => {
    const wire = tap(page);
    await page.goto("/h/BZQ7");
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 10_000 });

    await rideOutTheDrop(page);

    await expect(page.getByText("Up next:")).toContainText("Synthetic 60", { timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Start the hive" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Strobe", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(4000);
    expect(showCommandsAfterDrop(wire).map((m) => m.type)).toEqual(["SET_TRACK", "SET_MODE"]);
    expect(lastRoom(wire).transport.state).toBe("stopped");
    expect(lastRoom(wire).track?.id).toBe("synthetic-60s");
    await expect(page.getByRole("button", { name: "Start the hive" })).toBeVisible();
  });
});

test.describe("an ordinary blip: the server kept the room", () => {
  test.use({ mockScenario: "restart-blip.json" });

  test("the host page sends nothing; the song plays on, on the same timeline", async ({ page }) => {
    const wire = tap(page);
    await page.goto("/h/BZQ7");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    const before = lastRoom(wire);

    await rideOutTheDrop(page);
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => wire.states.some((s) => s.socket >= 2)).toBe(true);
    await page.waitForTimeout(4000);

    expect(showCommandsAfterDrop(wire)).toEqual([]);
    const after = lastRoom(wire);
    expect(after.createdAtServerTime).toBe(before.createdAtServerTime);
    expect(after.transport).toEqual(before.transport);
    expect(after.mode).toEqual(before.mode);
  });
});
