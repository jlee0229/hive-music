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
 * The projector gets an id of its own, kept per tab. The engine's default id is
 * `hive:clientId:<code>` in localStorage, which is shared by every page of this browser — and the
 * laptop driving the projector is usually the host's. Reusing it made /screen JOIN *as the host's
 * record*: the host was renamed "Screen (read-only)", lost its HEALTH feed to this tab, and was
 * marked disconnected when the projector tab closed.
 */
function screenClientId(roomCode: string): string {
  const key = `hive:screenId:${roomCode}`;
  const fresh = () => globalThis.crypto?.randomUUID?.() ?? `screen-${Math.random().toString(36).slice(2, 14)}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = fresh();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return fresh(); // SSR, or storage blocked
  }
}

/**
 * Read-only projector/judge display: code + QR, player count, full-bleed Hive Map, mode/scene
 * strip. No controls -- never renders a button that sends a message.
 *
 * Joins as kind: "viewer" (protocol v4): never a speaker, never counted as a player, never handed
 * a stem, no credential needed. It used to join as a "player", which the transport forces to
 * plays: true — so every projector was a silent phantom speaker that took a part in ORCHESTRA and
 * showed up on the host's map.
 */
export default function ScreenPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();
  const [clientId] = useState(() => screenClientId(roomCode));

  const { client, room, connection, health, healthServerTime } = useHiveClient({
    roomCode,
    // UseHiveClientOptions has not been widened to the engine's "viewer" kind yet; the value is
    // passed straight through to HiveClientOptions, which has.
    kind: "viewer" as "player",
    plays: false,
    name: "Screen",
    clientId,
    autoConnect: true,
  });

  const [joinUrl, setJoinUrl] = useState(`/j/${roomCode}`);
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/j/${roomCode}`);
  }, [roomCode]);

  // A projector cannot be scrolled, and the two commonest ones are 1280x720 and 1920x1080: the map
  // and the QR are sized from the window instead of fixed at 620/200 px (which overflowed 720p by
  // 134 px down and pushed the map off the right edge).
  const [win, setWin] = useState({ w: 1280, h: 720 });
  useEffect(() => {
    const fit = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const wide = win.w >= 900;
  const mapSize = Math.round(Math.max(240, wide ? Math.min((win.w - 112) * (1.4 / 2.4), win.h - 150) : win.w - 48));
  const qrSize = Math.round(Math.min(260, Math.max(120, win.h * 0.24)));

  const [missing, setMissing] = useState(false);
  useEffect(() => client.on("error", (errorCode) => {
    if (errorCode === "NO_ROOM") setMissing(true);
  }), [client]);

  const playerCount = room
    ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected && c.id !== client.clientId).length
    : 0;

  const syncSamples = Object.values(health)
    .map((h) => h.syncErrMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const medianSyncMs = syncSamples.length ? syncSamples[Math.floor(syncSamples.length / 2)]! : null;

  if (missing) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-10 text-center" style={{ background: "var(--stage)" }}>
        <h1 className="font-display text-4xl font-bold">Hive not found</h1>
        <p className="text-xl" style={{ color: "var(--muted)" }}>
          No hive is running at code {roomCode}.
        </p>
      </main>
    );
  }

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
    <main className={wide ? "grid h-dvh grid-cols-[1fr_1.4fr] gap-8 overflow-hidden p-10" : "flex min-h-dvh flex-col gap-6 p-6"} style={{ background: "var(--stage)" }}>
      <div className="flex min-h-0 min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="font-display text-2xl font-semibold" style={{ color: "var(--muted)" }}>
            HIVE
          </span>
          <span className="font-display text-[76px] leading-none font-extrabold tracking-[0.08em]">{roomCode}</span>
        </div>

        <div className="flex items-center gap-6 rounded-3xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="shrink-0 rounded-2xl bg-white p-3">
            <QrCode value={joinUrl} size={qrSize} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-lg" style={{ color: "var(--muted)" }}>
              Scan to join
            </span>
            <span className="font-mono text-2xl break-all">{joinUrl.replace(/^https?:\/\//, "")}</span>
          </div>
        </div>

        {/* One row, however many tiles there are (Synced only appears once there is a number). */}
        <div className="grid grid-flow-col gap-4" style={{ gridAutoColumns: "minmax(0, 1fr)" }}>
          <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Players
            </span>
            <span className="font-display text-4xl font-bold">{playerCount}</span>
          </div>
          {/* The server sends HEALTH to hosts, and to viewers only where it has been taught to, so
              without this check the tile read "—" for the whole party. */}
          {medianSyncMs == null ? null : (
            <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <span className="text-sm" style={{ color: "var(--muted)" }}>
                Synced
              </span>
              <span className="font-display text-4xl font-bold whitespace-nowrap">±{Math.round(medianSyncMs)} ms</span>
            </div>
          )}
          <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Mode
            </span>
            <span className="font-display text-4xl font-bold">{room ? modeLabel(room.mode.kind) : "—"}</span>
          </div>
        </div>

        {room ? <SceneStrip room={room} clock={client.clock} /> : null}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col items-center gap-4">
        {room ? (
          <>
            <div className="flex min-h-0 grow items-center justify-center">
              <HiveMap room={room} health={health} healthServerTime={healthServerTime} clock={client.clock} size={mapSize} excludeClientId={client.clientId} />
            </div>
            <Legend readOnly />
          </>
        ) : null}
      </div>
    </main>
  );
}
