import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { MAX_ROOM_OBSERVERS, Room, type Conn } from "../rooms";

/**
 * Audit SG-11. docs/02-protocol.md (v4): "HEALTH 1 Hz to hosts **and viewers**" — a /screen display's
 * "Synced ±N ms" tile is a median over exactly those numbers. The mock server sends it; the real
 * server only ever sent HEALTH to hostClientIds, so a real projector had nothing to show.
 */
type WS = Bun.ServerWebSocket<Conn>;
const device = { userAgent: "test", platform: "test", browserFamily: "desktop-chrome" as const };
const fakeServer = () => ({ publish: () => {} }) as unknown as Bun.Server<Conn>;
function fakeWs() {
  const sent: ServerMessage[] = [];
  const ws = { data: { clientId: null, roomCode: null }, send: (raw: string) => sent.push(JSON.parse(raw)), subscribe: () => {}, close: () => {} } as unknown as WS;
  return { ws, sent };
}
const join = (room: Room, clientId: string, kind: "host" | "player" | "viewer"): Extract<ClientMessage, { type: "JOIN" }> => ({
  type: "JOIN",
  clientId,
  roomCode: room.code,
  kind,
  plays: kind === "player",
  hostKey: kind === "host" ? room.hostKey : undefined,
  device,
  protocolVersion: PROTOCOL_VERSION,
});

describe("SG-11: viewers receive HEALTH", () => {
  test("host and viewer get the snapshot; players do not; a viewer still cannot do anything with it", () => {
    const room = new Room("VHLT", fakeServer(), () => {}, () => []);
    const host = fakeWs();
    const viewer = fakeWs();
    const player = fakeWs();
    room.join(host.ws, join(room, "host-vh-00001", "host"));
    room.join(viewer.ws, join(room, "view-vh-00001", "viewer"));
    room.join(player.ws, join(room, "play-vh-00001", "player"));
    room.handle(player.ws, { type: "CLIENT_STATUS", rttMs: 21, syncErrMs: 2.5, outputLatencyMs: null, audioState: "ready" });

    (room as unknown as { publishHealth(): void }).publishHealth();

    const healthOf = (s: { sent: ServerMessage[] }) => s.sent.filter((m) => m.type === "HEALTH");
    expect(healthOf(host)).toHaveLength(1);
    expect(healthOf(viewer)).toHaveLength(1);
    expect(healthOf(player)).toHaveLength(0);
    const snap = healthOf(viewer)[0]!;
    if (snap.type === "HEALTH") expect(snap.clients["play-vh-00001"]).toMatchObject({ rttMs: 21, syncErrMs: 2.5, audioState: "ready" });

    room.handle(viewer.ws, { type: "KICK", clientId: "play-vh-00001" });
    expect(room.room.clients["play-vh-00001"]).toBeDefined();
    expect(viewer.sent.some((m) => m.type === "ERROR" && m.code === "NOT_HOST")).toBe(true);
    room.destroy();
  });

  test("the host's own /screen tab (same browser, so the host's client id, no key) is an observer: it gets HEALTH without taking it from the host", () => {
    const room = new Room("VHL2", fakeServer(), () => {}, () => []);
    const host = fakeWs();
    room.join(host.ws, join(room, "host-vh-00002", "host"));
    const screen = fakeWs();
    // what apps/web/app/screen sends today: kind "player", and the browser's shared hive:clientId
    room.join(screen.ws, { ...join(room, "host-vh-00002", "player"), plays: false });
    expect(screen.sent.find((m) => m.type === "WELCOME")).toMatchObject({ isHost: false });

    const publish = () => (room as unknown as { publishHealth(): void }).publishHealth();
    publish();
    expect(host.sent.filter((m) => m.type === "HEALTH")).toHaveLength(1);
    expect(screen.sent.filter((m) => m.type === "HEALTH")).toHaveLength(1);

    room.disconnect(screen.ws); // closing the screen tab is not the host leaving, and stops its HEALTH
    publish();
    expect(room.room.clients["host-vh-00002"]!.connected).toBe(true);
    expect(host.sent.filter((m) => m.type === "HEALTH")).toHaveLength(2);
    expect(screen.sent.filter((m) => m.type === "HEALTH")).toHaveLength(1);

    // observers are capped: they are not client records, so nothing else would bound them
    const extra = Array.from({ length: MAX_ROOM_OBSERVERS + 3 }, () => fakeWs());
    for (const s of extra) room.join(s.ws, { ...join(room, "host-vh-00002", "player"), plays: false });
    expect(extra.filter((s) => s.sent.some((m) => m.type === "WELCOME"))).toHaveLength(MAX_ROOM_OBSERVERS);
    expect(extra.filter((s) => s.sent.some((m) => m.type === "ERROR" && m.code === "ROOM_FULL"))).toHaveLength(3);
    room.destroy();
  });
});
