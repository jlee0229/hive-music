"use client";

import { use, useEffect, useState } from "react";
import type { ModeKind } from "@hive/protocol";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { QrCode } from "@/components/QrCode";
import { HiveMap } from "@/components/HiveMap";
import { SceneStrip } from "@/components/SceneStrip";
import { Legend } from "@/components/Legend";

function modeLabel(kind: ModeKind): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

/**
 * Read-only projector/judge display: code + QR, player count, full-bleed Hive Map, mode/scene
 * strip. No controls -- never renders a button that sends a message.
 *
 * Joins as kind: "player", plays: false (the closest the current contract allows to a credential-
 * free viewer -- see docs/PROTOCOL-REQUESTS.md R-8). Until that lands: the server still counts this
 * connection as a player and may hand it a stem in ORCHESTRA's rotation, and the room-wide sync
 * median below reads "--" because HEALTH is only ever sent to registered hosts.
 */
export default function ScreenPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  const { client, room, connection, health, healthServerTime } = useHiveClient({
    roomCode,
    kind: "player",
    plays: false,
    name: "Screen (read-only)",
    autoConnect: true,
  });

  const [joinUrl, setJoinUrl] = useState(`/j/${roomCode}`);
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/j/${roomCode}`);
  }, [roomCode]);

  const playerCount = room
    ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected && c.id !== client.clientId).length
    : 0;

  const syncSamples = Object.values(health)
    .map((h) => h.syncErrMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const medianSyncMs = syncSamples.length ? syncSamples[Math.floor(syncSamples.length / 2)]! : null;

  if (connection !== "open" && !room) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-10 text-center" style={{ background: "var(--stage)" }}>
        <span className="font-display text-4xl font-bold">HIVE · {roomCode}</span>
        <span className="text-xl" style={{ color: "var(--muted)" }}>
          Connecting…
        </span>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh grid-cols-[1fr_1.4fr] gap-8 p-10" style={{ background: "var(--stage)" }}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-1">
          <span className="font-display text-2xl font-semibold" style={{ color: "var(--muted)" }}>
            HIVE
          </span>
          <span className="font-display text-[76px] leading-none font-extrabold tracking-[0.08em]">{roomCode}</span>
        </div>

        <div className="flex items-center gap-6 rounded-3xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="rounded-2xl bg-white p-3">
            <QrCode value={joinUrl} size={200} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-lg" style={{ color: "var(--muted)" }}>
              Scan to join
            </span>
            <span className="font-mono text-2xl">{joinUrl.replace(/^https?:\/\//, "")}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Players
            </span>
            <span className="font-display text-5xl font-bold">{playerCount}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Synced
            </span>
            <span className="font-display text-5xl font-bold">{medianSyncMs == null ? "—" : `±${Math.round(medianSyncMs)} ms`}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            Mode
          </span>
          <span className="font-display text-3xl font-bold">{room ? modeLabel(room.mode.kind) : "—"}</span>
        </div>

        {room ? <SceneStrip room={room} clock={client.clock} /> : null}
      </div>

      <div className="flex flex-col gap-4">
        {room ? (
          <>
            <div className="flex grow items-center justify-center">
              <HiveMap
                room={room}
                health={health}
                healthServerTime={healthServerTime}
                clock={client.clock}
                size={620}
                excludeClientId={client.clientId}
              />
            </div>
            <Legend readOnly />
          </>
        ) : null}
      </div>
    </main>
  );
}
