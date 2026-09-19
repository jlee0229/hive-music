"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ROLE_COLORS, HEALTH_COLORS } from "@hive/protocol";
import { detectDevice } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { getPlayerName, setPlayerName } from "@/lib/hive/storage";
import { formatMs, selfHealthLevel, stems as stemsOf } from "@/lib/hive/derive";
import { RingerBanner } from "@/components/RingerBanner";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { PlayerPlayingScreen } from "@/components/PlayerPlayingScreen";
import { PlayerCalibratingScreen } from "@/components/PlayerCalibratingScreen";

type View = "join" | "ready" | "playing" | "calibrating" | "removed";

export default function PlayerPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  const [name, setName] = useState(() => getPlayerName());
  const [joinRequested, setJoinRequested] = useState(false);
  const [joining, setJoining] = useState(false);
  const [removedReason, setRemovedReason] = useState<string | null>(null);
  const device = detectDevice();

  const { client, room, me, connection, status, audio, connect } = useHiveClient({
    roomCode,
    kind: "player",
    plays: true,
    name: name || undefined,
  });

  useEffect(() => {
    return client.on("error", (code, message) => {
      if (code === "KICKED") setRemovedReason(message || "Removed from hive");
      if (code === "NO_ROOM") setRemovedReason("This hive no longer exists.");
    });
  }, [client]);

  async function handleJoin() {
    setJoining(true);
    setPlayerName(name);
    setJoinRequested(true);
    try {
      await client.audio.unlock();
      await connect();
    } catch {
      // ERROR events / the reconnect banner surface anything that goes wrong.
    } finally {
      setJoining(false);
    }
  }

  let view: View = "join";
  if (removedReason) view = "removed";
  else if (joinRequested && audio.state !== "locked") {
    if (room?.calibration.state === "countdown" || room?.calibration.state === "running") view = "calibrating";
    else if (room?.transport.state === "playing") view = "playing";
    else view = "ready";
  }

  if (view === "removed") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-display text-3xl font-bold">Removed from hive</h1>
        <p style={{ color: "var(--muted)" }}>{removedReason}</p>
        <Link href="/" className="mt-4 rounded-2xl px-6 py-3 font-semibold" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
          Back home
        </Link>
      </main>
    );
  }

  if (view === "playing") {
    return (
      <PlayerPlayingScreen
        client={client}
        room={room!}
        me={me}
        status={status}
        connection={connection}
        muted={audio.muted}
        roomCode={roomCode}
        name={name}
      />
    );
  }

  if (view === "calibrating") {
    return <PlayerCalibratingScreen room={room!} me={me} name={name} />;
  }

  if (view === "ready") {
    const trackStems = stemsOf(room);
    const partsDone = Math.round(audio.loadProgress * trackStems.length);
    const level = selfHealthLevel(status, audio.state, client.clock.serverNow());
    const ringColor = HEALTH_COLORS[level];
    const roleColor = me?.assignment ? ROLE_COLORS[me.assignment.role] : "#94A3B8";

    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6" style={{ padding: "56px 24px 32px" }}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: roleColor }} />
            {name || "You"}
          </span>
          <span className="font-mono rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
            {roomCode}
          </span>
        </div>

        <ReconnectBanner connection={connection} />

        <div className="flex flex-col items-center gap-3.5 pt-4 pb-2">
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" aria-hidden="true">
            <circle cx="60" cy="60" r="54" stroke="var(--raised)" strokeWidth="6" />
            <circle
              cx="60"
              cy="60"
              r="54"
              stroke={ringColor}
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray="339 339"
              transform="rotate(-90 60 60)"
            />
            {level === "good" || level === "warn" ? (
              <path d="M40 62l13 13 27-30" stroke={ringColor} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            ) : null}
          </svg>
          <span className="font-display text-[34px] font-bold tracking-tight">{status.syncErrMs == null ? "Syncing…" : "Synced"}</span>
          <span className="font-mono text-[15px]" style={{ color: "var(--muted)" }}>
            clock {formatMs(status.syncErrMs)} · rtt {status.rttMs == null ? "—" : `${Math.round(status.rttMs)} ms`}
          </span>
        </div>

        <div className="flex flex-col gap-2.5 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
          <div className="flex justify-between text-sm">
            <span className="font-semibold">Downloading the song</span>
            <span className="font-mono" style={{ color: "var(--muted)" }}>
              {trackStems.length ? `${Math.min(partsDone, trackStems.length)} / ${trackStems.length} parts` : "—"}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--raised)" }}>
            <div className="h-2 rounded-full" style={{ width: `${Math.round(audio.loadProgress * 100)}%`, background: "var(--primary-fill)" }} />
          </div>
        </div>

        {me?.assignment ? (
          <div className="flex items-center gap-3.5 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
            <span className="h-11 w-11 shrink-0 rounded-xl" style={{ background: roleColor }} />
            <div className="flex flex-col gap-1">
              <span className="text-xs tracking-widest" style={{ color: "var(--muted)" }}>
                YOU&apos;LL PLAY
              </span>
              <span className="font-display text-[22px] font-bold" style={{ color: roleColor }}>
                {me.assignment.label}
              </span>
              <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                The host can change this during the show.
              </span>
            </div>
          </div>
        ) : null}

        <div className="grow" />

        <div className="flex flex-col items-center gap-2">
          <span className="flex items-center gap-2 text-[15px]" style={{ color: "var(--muted)" }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--muted)" }} />
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--faint)" }} />
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--border)" }} />
            {room?.transport.state === "paused" ? "Paused — waiting for the host" : "Waiting for the host to start"}
          </span>
          <span className="text-[13px]" style={{ color: "var(--faint)" }}>
            Keep your screen on. Don&apos;t lock your phone.
          </span>
        </div>
      </main>
    );
  }

  // view === "join"
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6" style={{ padding: "56px 24px 32px" }}>
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold">Joining a hive</span>
        <span className="font-mono rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          {roomCode}
        </span>
      </div>

      <label className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--muted)" }}>
        Your name
        <input
          value={name}
          onChange={(e) => {
            const v = e.target.value.slice(0, 32);
            setName(v);
            setPlayerName(v);
          }}
          placeholder="Your name"
          className="h-14 rounded-2xl border px-4 text-lg outline-none"
          style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--text)" }}
        />
      </label>

      {device.browserFamily === "ios-safari" ? <RingerBanner /> : null}

      <div className="flex flex-col gap-2 rounded-2xl border p-4" style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <span className="text-[13px]" style={{ color: "var(--muted)" }}>
          What happens next
        </span>
        <div className="flex flex-col gap-2 text-sm leading-snug">
          <span>1. Your phone syncs its clock with the hive.</span>
          <span>2. It downloads the song&apos;s parts (a few seconds).</span>
          <span>3. The host presses play. You&apos;re part of the speaker.</span>
        </div>
      </div>

      <div className="grow" />

      <div className="flex flex-col gap-2.5">
        <button
          onClick={handleJoin}
          disabled={joining}
          className="flex h-16 items-center justify-center rounded-[18px] text-lg font-semibold disabled:opacity-60"
          style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}
        >
          {joining ? "Joining…" : "Tap to join"}
        </button>
        <p className="text-center text-[13px] leading-snug" style={{ color: "var(--faint)" }}>
          The tap lets your phone play sound. Keep this page open afterwards.
        </p>
      </div>
    </main>
  );
}
