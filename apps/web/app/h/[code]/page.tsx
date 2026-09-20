"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { TrackLibraryEntry } from "@hive/protocol";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { apiUrl } from "@/lib/hive/client";
import { getHostKey, setHostKey } from "@/lib/hive/storage";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { ProtocolMismatchBanner } from "@/components/ProtocolMismatchBanner";
import { QrCode } from "@/components/QrCode";
import { TransportBar } from "@/components/TransportBar";
import { HiveMap } from "@/components/HiveMap";
import { ModeChips } from "@/components/ModeChips";
import { VibeBox } from "@/components/VibeBox";
import { SceneStrip } from "@/components/SceneStrip";
import { HostCalibrate } from "@/components/HostCalibrate";
import { Legend } from "@/components/Legend";
import { PlayerSheet } from "@/components/PlayerSheet";
import { PlayersDrawer } from "@/components/PlayersDrawer";

export default function HostPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  const [hostKeyState, setHostKeyState] = useState<string | null>(() => getHostKey(roomCode));
  const [roomError, setRoomError] = useState<string | null>(null);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<TrackLibraryEntry[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [startAnywayReady, setStartAnywayReady] = useState(false);
  const [sheetClientId, setSheetClientId] = useState<string | null>(null);
  const [showPlayers, setShowPlayers] = useState(false);
  const [calibrateDismissed, setCalibrateDismissed] = useState(false);
  const [screenLinkCopied, setScreenLinkCopied] = useState(false);

  useEffect(() => {
    if (hostKeyState) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiUrl()}/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: roomCode }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { code: string; hostKey: string };
        if (cancelled) return;
        setHostKey(data.code, data.hostKey);
        setHostKeyState(data.hostKey);
      } catch {
        if (!cancelled) setRoomError("Could not create the hive. Is the server running?");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomCode, hostKeyState]);

  const { client, room, connection, audio, health, healthServerTime, protocolMismatch } = useHiveClient({
    roomCode,
    kind: "host",
    plays: speakerOn,
    hostKey: hostKeyState ?? undefined,
    name: "Host",
    autoConnect: !!hostKeyState,
  });

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    fetch(`${apiUrl()}/tracks${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => r.json())
      .then((d: { tracks: TrackLibraryEntry[] }) => {
        if (!cancelled) setTracks(d.tracks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Auto-pick the first library track once the room exists and has none — and actually push it
  // to the server (host.setTrack), not just the local radio state: the mock scenarios always
  // pre-seed a track, but a fresh real room starts with track: null, so "Start" would otherwise
  // send TRANSPORT into a room with nothing loaded (ERROR NO_TRACK) until the user happened to
  // click a radio button that was already visually checked.
  useEffect(() => {
    if (!room) return;
    if (room.track) {
      setSelectedTrackId(room.track.id);
      return;
    }
    if (!selectedTrackId && tracks[0]) {
      setSelectedTrackId(tracks[0].id);
      client.host.setTrack(tracks[0].id);
    }
  }, [room, tracks, selectedTrackId, client]);

  useEffect(() => {
    setStartAnywayReady(false);
    if (!room?.track) return;
    const t = setTimeout(() => setStartAnywayReady(true), 10_000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.track?.id]);

  function toggleSpeaker(on: boolean) {
    setSpeakerOn(on);
    if (on) client.audio.unlock().catch(() => {});
    client.host.setPlays(on);
  }

  function selectTrack(id: string) {
    setSelectedTrackId(id);
    client.host.setTrack(id);
  }

  async function copyScreenLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/screen/${roomCode}`);
      setScreenLinkCopied(true);
      setTimeout(() => setScreenLinkCopied(false), 2000);
    } catch {
      // clipboard API can be blocked (permissions, non-HTTPS); nothing else to do from here
    }
  }

  const [joinUrl, setJoinUrl] = useState(`/j/${roomCode}`);
  useEffect(() => {
    setJoinUrl(`${window.location.origin}/j/${roomCode}`);
  }, [roomCode]);
  const playerCount = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected).length : 0;
  const connectedPlayers = room ? Object.values(room.clients).filter((c) => c.kind === "player" && c.connected) : [];
  const allReady = !!room?.track && connectedPlayers.every((c) => c.audioReadyTrackId === room.track!.id);
  const canStart = !!room?.track && (allReady || startAnywayReady || connectedPlayers.length === 0);
  const showStage = !!room?.track && room.transport.state !== "stopped";
  const calibrationActive = room ? room.calibration.state === "countdown" || room.calibration.state === "running" || room.calibration.state === "failed" : false;
  const showCalibrate = calibrationActive && !calibrateDismissed;

  if (roomError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="font-display text-2xl font-bold">Couldn&apos;t start the hive</h1>
        <p style={{ color: "var(--muted)" }}>{roomError}</p>
      </main>
    );
  }

  if (showCalibrate && room) {
    return (
      <main className="mx-auto min-h-dvh max-w-md">
        <HostCalibrate room={room} clock={client.clock} host={client.host} onClose={() => setCalibrateDismissed(true)} />
      </main>
    );
  }

  if (showStage && room) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-3.5" style={{ padding: safeAreaPadding(52, 20, 24) }}>
        <div className="flex items-center justify-between">
          <span className="font-mono rounded-full border px-3 py-1.5 text-[13px] tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            {roomCode}
          </span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>
            {playerCount} players
          </span>
          <span className="font-mono rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-widest" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
            HOST
          </span>
        </div>

        <ReconnectBanner connection={connection} />
        <ProtocolMismatchBanner show={protocolMismatch} />

        <div className="flex items-center justify-between rounded-2xl border px-3.5 py-2.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <Link href={`/screen/${roomCode}`} target="_blank" className="text-[13px] font-semibold underline">
            Show on screen
          </Link>
          <button onClick={copyScreenLink} className="text-[13px] font-semibold" style={{ color: "var(--muted)" }}>
            {screenLinkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>

        <TransportBar room={room} clock={client.clock} host={client.host} />

        <ModeChips current={room.mode.kind} host={client.host} />

        <VibeBox host={client.host} />
        <SceneStrip room={room} clock={client.clock} />

        <div className="rounded-2xl border p-3 text-sm" style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--muted)" }}>
          Tuning is built in gate F7.
        </div>

        <div className="flex justify-center">
          <HiveMap room={room} health={health} healthServerTime={healthServerTime} clock={client.clock} host={client.host} onOpenSheet={setSheetClientId} />
        </div>

        <Legend />

        <div className="flex gap-2.5">
          <button
            onClick={() => {
              setCalibrateDismissed(false);
              client.host.startCalibration().catch(() => {});
            }}
            className="flex h-13 grow items-center justify-center rounded-2xl border font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
          >
            Tune the hive
          </button>
          <button
            onClick={() => setShowPlayers(true)}
            className="flex h-13 grow items-center justify-center rounded-2xl border font-semibold"
            style={{ height: 52, background: "var(--surface)", borderColor: "var(--border)" }}
          >
            Players
          </button>
        </div>

        {sheetClientId && room.clients[sheetClientId] ? (
          <PlayerSheet client={room.clients[sheetClientId]!} host={client.host} onClose={() => setSheetClientId(null)} />
        ) : null}
        {showPlayers ? (
          <PlayersDrawer
            room={room}
            health={health}
            healthServerTime={healthServerTime}
            onSelect={(id) => {
              setShowPlayers(false);
              setSheetClientId(id);
            }}
            onClose={() => setShowPlayers(false)}
          />
        ) : null}
      </main>
    );
  }

  // Lobby
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4.5" style={{ padding: safeAreaPadding(52, 24, 28) }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold">Your hive</span>
        <span className="font-mono rounded-full px-3 py-1.5 text-xs font-semibold tracking-widest" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
          HOST
        </span>
      </div>

      <ReconnectBanner connection={connection} />
      <ProtocolMismatchBanner show={protocolMismatch} />

      <div className="flex flex-col items-center gap-3">
        <span className="font-display text-[60px] leading-none font-extrabold tracking-[0.14em]">{roomCode}</span>
        <div className="flex h-[220px] w-[220px] items-center justify-center rounded-[20px]" style={{ background: "#FFFFFF" }}>
          <QrCode value={joinUrl} size={172} />
        </div>
        <span className="font-mono text-sm" style={{ color: "var(--muted)" }}>
          {joinUrl.replace(/^https?:\/\//, "")}
        </span>
      </div>

      <div className="flex items-center justify-between rounded-2xl border px-4 py-3" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <span className="text-[15px] font-semibold">{playerCount} joined</span>
        <div className="flex gap-1.5">
          {Array.from({ length: Math.min(playerCount, 8) }).map((_, i) => (
            <span key={i} className="h-3 w-3 rounded-full" style={{ background: "var(--muted)" }} />
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3.5 rounded-2xl border p-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <input
          type="checkbox"
          checked={speakerOn}
          onChange={(e) => toggleSpeaker(e.target.checked)}
          className="mt-0.5 h-6 w-6 shrink-0"
          style={{ accentColor: "var(--primary-fill)" }}
        />
        <span className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">Use this phone as a speaker too</span>
          <span className="text-[13px] leading-snug" style={{ color: "var(--muted)" }}>
            Off: this phone only runs the show and listens during tuning.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-2.5">
        <label className="flex h-12 items-center gap-2.5 rounded-2xl border px-3.5" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the library"
            aria-label="Search the library"
            className="grow bg-transparent text-[15px] outline-none"
            style={{ color: "var(--text)" }}
          />
        </label>
        {tracks.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 rounded-2xl border px-3.5 py-3"
            style={{ background: "var(--surface)", borderColor: selectedTrackId === t.id ? "var(--primary-fill)" : "var(--border)" }}
          >
            <input
              type="radio"
              name="track"
              checked={selectedTrackId === t.id}
              onChange={() => selectTrack(t.id)}
              className="h-5 w-5"
              style={{ accentColor: "var(--primary-fill)" }}
            />
            <span className="flex grow flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{t.title}</span>
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                {t.stems.length} parts · {Math.round(t.durationSec)}s · {t.stems.join(" ")}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="grow" />

      <button
        onClick={() => selectedTrackId && client.host.play(0)}
        disabled={!selectedTrackId || !canStart}
        className="flex h-14 items-center justify-center rounded-2xl text-lg font-semibold disabled:opacity-60"
        style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
      >
        {!selectedTrackId
          ? "Pick a track"
          : allReady || connectedPlayers.length === 0
            ? "Start the hive"
            : startAnywayReady
              ? "Start anyway"
              : "Waiting for phones to load…"}
      </button>
      {audio.state === "locked" && speakerOn ? (
        <p className="text-center text-xs" style={{ color: "var(--faint)" }}>
          Tap the speaker toggle again if this phone doesn&apos;t make sound once the show starts.
        </p>
      ) : null}
    </main>
  );
}
