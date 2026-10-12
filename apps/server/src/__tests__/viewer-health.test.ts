import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { Room, type Conn } from "../rooms";

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
});
