"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ROLE_COLORS, HEALTH_COLORS } from "@hive/protocol";
import { detectDevice } from "@hive/sync-client";
import { useHiveClient } from "@/lib/hive/useHiveClient";
import { safeAreaPadding } from "@/lib/hive/safe-area";
import { getPlayerName, setPlayerName } from "@/lib/hive/storage";
import { selfHealthLevel, stems as stemsOf } from "@/lib/hive/derive";
import { RingerBanner } from "@/components/RingerBanner";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { ProtocolMismatchBanner } from "@/components/ProtocolMismatchBanner";
import { PlayerPlayingScreen } from "@/components/PlayerPlayingScreen";
import { PlayerCalibratingScreen } from "@/components/PlayerCalibratingScreen";
import { AdSlot } from "@/components/AdSlot";
import { Creators } from "@/components/Creators";

type View = "join" | "resume" | "ready" | "playing" | "calibrating" | "removed";

export default function PlayerPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const roomCode = code.toUpperCase();

  const [name, setName] = useState(() => getPlayerName());
  const [joinRequested, setJoinRequested] = useState(false);
  const [joining, setJoining] = useState(false);
  const [removed, setRemoved] = useState<{ heading: string; detail: string } | null>(null);
  const [resuming, setResuming] = useState(false);
  const device = detectDevice();

  const { client, room, me, connection, status, audio, connect, protocolMismatch } = useHiveClient({
    roomCode,
    kind: "player",
    plays: true,
    name: name || undefined,
  });

  useEffect(() => {
    return client.on("error", (code, message) => {
      if (code === "KICKED") setRemoved({ heading: "Removed from hive", detail: message || "The host removed this phone." });
      if (code === "NO_ROOM") setRemoved({ heading: "Hive not found", detail: `No hive is running at code ${roomCode}.` });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Set synchronously (before any await) so a tap on the button and the bubbled tap on the
  // full-screen container behind it — the "unlock target is the whole screen" requirement —
  // never both run handleJoin for the same gesture.
  const startedRef = useRef(false);

  async function handleJoin() {
    if (startedRef.current) return;
    startedRef.current = true;
    setJoining(true);
    setPlayerName(name);
    setJoinRequested(true);
    try {
      await client.audio.unlock();
      await connect();
    } catch {
      // ERROR events / the reconnect banner surface anything that goes wrong.
      startedRef.current = false; // let a retry tap work
    } finally {
      setJoining(false);
    }
  }

  // iOS suspends/interrupts the AudioContext on a lock screen, an incoming call, or Siri --
  // audio.state goes back to "locked" mid-session. Resuming needs only unlock() (it re-resumes the
  // existing context and re-requests the wake lock); calling connect() again would open a second
  // socket for the same client on top of the one that never actually dropped.
  async function handleResume() {
    if (resuming) return;
    setResuming(true);
    try {
      await client.audio.unlock();
    } catch {
      // stays on the resume screen; another tap retries
    } finally {
      setResuming(false);
    }
  }

  const [flash, setFlash] = useState(false);
  useEffect(() => {
    // Registered here (not inside the Calibrating screen) so a click that arrives before the
    // coalesced ROOM_STATE switches us into "calibrating" still flashes.
    //
    // The event fires on SCHEDULED_ACTION receipt, which lands ~3s + k*400ms before the click
    // actually plays -- flashing immediately would show it far too early. Time it to the click
    // itself via the shared clock instead.
    let showTimer: ReturnType<typeof setTimeout> | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const off = client.on("calibrationClick", (clickAtServerTime) => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      const delayMs = Math.max(0, clickAtServerTime - client.clock.serverNow());
      showTimer = setTimeout(() => {
        setFlash(true);
        hideTimer = setTimeout(() => setFlash(false), 300);
      }, delayMs);
    });
    return () => {
      off();
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [client]);

  let view: View = "join";
  if (removed) view = "removed";
  else if (joinRequested && audio.state === "locked") view = "resume";
  else if (joinRequested) {
    if (room?.calibration.state === "countdown" || room?.calibration.state === "running") view = "calibrating";
    else if (room?.transport.state === "playing") view = "playing";
    else view = "ready";
  }

  const flashOverlay = flash ? (
    <div data-testid="calibration-flash" className="pointer-events-none fixed inset-0 z-50" style={{ background: "#FFFFFF" }} aria-hidden="true" />
  ) : null;

  let body: React.ReactNode;
  if (view === "removed") {
    body = (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="font-display text-3xl font-bold">{removed!.heading}</h1>
        <p style={{ color: "var(--muted)" }}>{removed!.detail}</p>
        <Link href="/" className="mt-4 rounded-2xl px-6 py-3 font-semibold" style={{ background: "var(--primary-fill)", color: "var(--primary-text)" }}>
          Back home
        </Link>
      </main>
    );
  }

  if (view === "resume") {
    body = (
      <main
        className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
        style={{ overscrollBehavior: "none", touchAction: "manipulation" }}
        onClick={handleResume}
      >
        <h1 className="font-display text-3xl font-bold">{resuming ? "Resuming…" : "Tap to resume"}</h1>
        <p style={{ color: "var(--muted)" }}>Sound paused — a call, the lock screen, or Siri interrupted it.</p>
      </main>
    );
  }

  if (view === "playing") {
    body = (
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
    body = <PlayerCalibratingScreen client={client} room={room!} me={me} name={name} />;
  }

  if (view === "ready") {
    const trackStems = stemsOf(room);
    const partsDone = Math.round(audio.loadProgress * trackStems.length);
    const level = selfHealthLevel(status, audio.state, client.clock.serverNow());
    const ringColor = HEALTH_COLORS[level];
    const roleColor = me?.assignment ? ROLE_COLORS[me.assignment.role] : "#94A3B8";

    body = (
      // h-dvh + overflow-hidden silently clips anything that doesn't fit — so this screen stays
      // compact enough that the footer (ad slot + creators) is always on screen.
      <main className="mx-auto flex h-dvh max-w-md flex-col gap-3 overflow-hidden" style={{ padding: safeAreaPadding(40, 20, 14) }}>
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
        <ProtocolMismatchBanner show={protocolMismatch} />

        <div className="flex flex-col items-center gap-2.5 pt-1">
          <svg width="96" height="96" viewBox="0 0 120 120" fill="none" aria-hidden="true">
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

        <AdSlot />
        <Creators />
      </main>
    );
  }

  if (view === "join") {
    body = (
    <main
      className="mx-auto flex min-h-dvh max-w-md flex-col gap-6"
      style={{ padding: safeAreaPadding(56, 24, 32) }}
      onClick={handleJoin}
    >
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold">Joining a hive</span>
        <span className="font-mono rounded-full border px-3 py-1.5 text-sm tracking-widest" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          {roomCode}
        </span>
      </div>

      <ProtocolMismatchBanner show={protocolMismatch} />

      <label className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--muted)" }} onClick={(e) => e.stopPropagation()}>
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

  return (
    <>
      {body}
      {flashOverlay}
    </>
  );
}
