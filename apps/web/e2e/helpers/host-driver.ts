/**
 * Drives the mock server's WebSocket protocol directly from a Playwright test, standing in for
 * "a host client" — e.g. sending ASSIGN to prove a player's screen reacts to a real ROOM_STATE
 * change (F3), without needing the Hive Map UI (that's F4). Test-only: never used by app code.
 */
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@hive/protocol";
import { MOCK_URL } from "./mock";

export interface HostDriver {
  send: (msg: ClientMessage) => void;
  waitForRoomState: () => Promise<ServerMessage & { type: "ROOM_STATE" }>;
  close: () => void;
}

export async function connectAsHost(roomCode: string, hostKey = "mock-host-key"): Promise<HostDriver> {
  const wsUrl = MOCK_URL.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  const roomStateWaiters: Array<(m: ServerMessage & { type: "ROOM_STATE" }) => void> = [];

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      const join: ClientMessage = {
        type: "JOIN",
        clientId: `e2e-host-${Math.random().toString(36).slice(2, 10)}`,
        roomCode,
        kind: "host",
        plays: false,
        hostKey,
        name: "e2e host driver",
        device: { userAgent: "playwright", platform: "test", browserFamily: "other" },
        protocolVersion: PROTOCOL_VERSION,
      };
      ws.send(JSON.stringify(join));
    };
    ws.onerror = () => reject(new Error("host driver socket error"));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "WELCOME") resolve();
      if (msg.type === "ROOM_STATE") for (const w of roomStateWaiters.splice(0)) w(msg);
    };
  });

  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitForRoomState: () =>
      new Promise((resolve) => {
        roomStateWaiters.push(resolve);
      }),
    close: () => ws.close(),
  };
}
