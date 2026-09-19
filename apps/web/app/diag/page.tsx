"use client";

import { useEffect, useState } from "react";
import { PROTOCOL_VERSION } from "@hive/protocol";
import { detectDevice } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { formatMs } from "@/lib/hive/derive";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b py-2 text-sm" style={{ borderColor: "var(--border)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

export default function DiagPage() {
  const [roomCode, setRoomCode] = useState("BZQ7");
  const [joined, setJoined] = useState(false);
  const [wakeLockState, setWakeLockState] = useState("unknown");
  const [audioSessionType, setAudioSessionType] = useState("unavailable");

  const { client, room, connection, status, audio } = useHiveClient({
    roomCode,
    kind: "player",
    plays: true,
    name: "diag",
  });

  useEffect(() => {
    const nav = navigator as Navigator & { audioSession?: { type: string }; wakeLock?: unknown };
    setAudioSessionType(nav.audioSession?.type ?? "unavailable");
    setWakeLockState(nav.wakeLock ? "supported (not requested by /diag)" : "unsupported");
  }, []);

  const device = detectDevice();

  async function connectNow() {
    await client.audio.unlock();
    await client.connect().catch(() => {});
    setJoined(true);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6">
      <h1 className="font-display text-2xl font-bold">/diag</h1>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        The 30-second phone checklist. Connects like a player would; shows the live sync numbers.
      </p>

      {!joined ? (
        <div className="flex flex-col gap-3 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <label className="flex flex-col gap-1 text-xs" style={{ color: "var(--muted)" }}>
            Room code
            <input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              className="font-mono h-12 rounded-xl border px-3 text-lg tracking-widest uppercase outline-none"
              style={{ background: "var(--stage)", borderColor: "var(--border)", color: "var(--text)" }}
            />
          </label>
          <button
            onClick={connectNow}
            className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold"
            style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
          >
            Tap to connect
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Row label="clientId" value={client.clientId} />
          <Row label="protocolVersion" value={String(PROTOCOL_VERSION)} />
          <Row label="connection" value={connection} />
          <Row label="rttMs" value={formatMs(status.rttMs)} />
          <Row label="clockOffsetMs" value={formatMs(status.clockOffsetMs)} />
          <Row label="syncErrMs" value={formatMs(status.syncErrMs)} />
          <Row label="outputLatencyMs" value={formatMs(status.outputLatencyMs)} />
          <Row label="compensationMs" value={formatMs(status.compensationMs)} />
          <Row label="audio.state" value={audio.state} />
          <Row label="audio.loadProgress" value={`${Math.round(audio.loadProgress * 100)}%`} />
          <Row label="browserFamily" value={device.browserFamily} />
          <Row label="platform" value={device.platform} />
          <Row label="wakeLock" value={wakeLockState} />
          <Row label="navigator.audioSession?.type" value={audioSessionType} />
          <Row label="room.code" value={room?.code ?? "—"} />
          <Row label="room.track" value={room?.track?.title ?? "—"} />
        </div>
      )}
    </main>
  );
}
