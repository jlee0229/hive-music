"use client";

import { Fragment, use, useEffect, useState } from "react";
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
  // On a 1080p wall there is room under the tiles that the QR can use; on 720p there is not.
  const qrSize = Math.round(win.h >= 900 ? Math.min(360, win.h * 0.3) : Math.min(260, Math.max(120, win.h * 0.24)));
  // Type that is read from across a room scales with the screen (it was fixed at phone sizes:
  // 14 px tile labels and an 18 px "Scan to join" on a 1920 px wall).
  const label = { fontSize: "clamp(0.875rem, 1vw, 1.25rem)" };
  const numeral = { fontSize: "clamp(1.5rem, 2.4vw, 3rem)" };

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
          <span className="font-display font-semibold" style={{ color: "var(--muted)", fontSize: "clamp(1.5rem, 1.9vw, 2.25rem)" }}>
            HIVE
          </span>
          <span className="font-display leading-none font-extrabold tracking-[0.08em]" style={{ fontSize: "clamp(4.75rem, 6vw, 7.5rem)" }}>
            {roomCode}
          </span>
        </div>

        <div className="flex items-center gap-6 rounded-3xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="shrink-0 rounded-2xl bg-white p-3">
            <QrCode value={joinUrl} size={qrSize} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span style={{ color: "var(--muted)", fontSize: "clamp(1.125rem, 1.5vw, 1.75rem)" }}>Scan to join</span>
            {/* Breaks after a slash, never in the middle of the domain or the code ("localhost:317 /
                0/j/BZQ7" was how break-all set it at 1280 px). */}
            <span className="font-mono break-words" style={{ fontSize: "clamp(1.125rem, 1.6vw, 2rem)" }}>
              {joinUrl
                .replace(/^https?:\/\//, "")
                .split("/")
                .map((part, i, parts) => (
                  // Fragments, not spans: no element here should have the bare code as its whole text.
                  <Fragment key={i}>
                    {part}
                    {i < parts.length - 1 ? "/" : ""}
                    <wbr />
                  </Fragment>
                ))}
            </span>
          </div>
        </div>

        {/* One row, however many tiles there are (Synced only appears once there is a number). */}
        {/* Numbers take the room they need and the mode gets the rest: in three equal columns
            "Orchestra" ran out of its 150 px tile at 1280 px. */}
        <div className="grid gap-4" style={{ gridTemplateColumns: medianSyncMs == null ? "auto minmax(0, 1fr)" : "auto auto minmax(0, 1fr)" }}>
          <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span style={{ color: "var(--muted)", ...label }}>Players</span>
            <span className="font-display leading-tight font-bold" style={numeral}>
              {playerCount}
            </span>
          </div>
          {/* The server sends HEALTH to hosts, and to viewers only where it has been taught to, so
              without this check the tile read "—" for the whole party. */}
          {medianSyncMs == null ? null : (
            <div className="flex flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
              <span style={{ color: "var(--muted)", ...label }}>Synced</span>
              <span className="font-display leading-tight font-bold whitespace-nowrap" style={numeral}>
                ±{Math.round(medianSyncMs)} ms
              </span>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1 rounded-2xl border p-5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span style={{ color: "var(--muted)", ...label }}>Mode</span>
            <span data-testid="screen-mode" className="font-display truncate leading-tight font-bold" style={numeral}>
              {room ? modeLabel(room.mode.kind) : "—"}
            </span>
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
