"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientRecord, RoomState } from "@hive/protocol";
import { ROLE_COLORS } from "@hive/protocol";
import type { ConnectionState, HiveClient, SyncStatus } from "@hive/sync-client";
import { beatPhase, formatMs, formatTrackTime, inkForRole, patternGain } from "@/lib/hive/derive";
import { ReconnectBanner } from "@/components/ReconnectBanner";
import { NudgeSlider } from "@/components/NudgeSlider";

/** Full-screen role color, beat pulse (bpm + evaluatePattern), nudge slider, mute. */
export function PlayerPlayingScreen({
  client,
  room,
  me,
  status,
  connection,
  muted,
  roomCode,
}: {
  client: HiveClient;
  room: RoomState;
  me: ClientRecord | null;
  status: SyncStatus;
  connection: ConnectionState;
  muted: boolean;
  roomCode: string;
  name: string;
}) {
  const assignment = me?.assignment ?? null;
  const roleColor = assignment ? ROLE_COLORS[assignment.role] : ROLE_COLORS.unison;
  const ink = assignment ? inkForRole(assignment.role) : "#0B0F14";

  const [trackTimeSec, setTrackTimeSec] = useState(0);
  const [pulse, setPulse] = useState(0);
  const [gain, setGain] = useState(1);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const t = client.clock.trackTimeSec();
      setTrackTimeSec(t);
      const phase = beatPhase(t, room.track?.bpm);
      const g = patternGain(assignment?.pattern, t);
      setGain(g);
      // a short decaying pulse right on the downbeat, scaled by the pattern's current gain
      const attack = Math.max(0, 1 - phase * 3);
      setPulse(attack * g);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [client, room.track?.bpm, assignment]);

  return (
    <main
      className="relative flex min-h-dvh flex-col justify-between overflow-hidden"
      style={{ background: roleColor, color: ink, padding: "52px 24px 28px" }}
    >
      {assignment?.pattern ? (
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{ background: "#0B0F14", opacity: (1 - gain) * 0.85 }}
        />
      ) : null}
      <svg
        className="pointer-events-none absolute"
        style={{ left: -105, top: 122, transform: `scale(${1 + pulse * 0.06})`, transformOrigin: "center", transition: "transform 60ms linear" }}
        width="600"
        height="600"
        viewBox="0 0 600 600"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="300" cy="300" r="120" stroke={ink} strokeOpacity="0.22" strokeWidth="2" />
        <circle cx="300" cy="300" r="200" stroke={ink} strokeOpacity="0.14" strokeWidth="2" />
        <circle cx="300" cy="300" r="280" stroke={ink} strokeOpacity="0.07" strokeWidth="2" />
      </svg>

      <div className="relative flex items-center justify-between">
        <span className="font-mono text-[13px] tracking-widest opacity-80">HIVE · {roomCode}</span>
        <span
          className="font-mono flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px]"
          style={{ background: "rgba(11,15,20,0.35)", color: "#F1F5F9" }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: "#22C55E" }} />
          {formatMs(status.syncErrMs)}
        </span>
      </div>

      <div ref={ringRef} className="relative flex flex-col items-center gap-2.5">
        <span className="text-[13px] tracking-[0.22em] opacity-75">YOU ARE</span>
        <span className="font-display text-[76px] leading-none font-extrabold tracking-tight uppercase">
          {assignment?.label ?? "Unison"}
        </span>
        <span className="text-[15px] opacity-80">
          {room.track?.title ?? "—"} · {formatTrackTime(trackTimeSec)}
        </span>
      </div>

      <div className="relative flex flex-col gap-3 rounded-[20px] p-4" style={{ background: "rgba(11,15,20,0.6)", color: "#F1F5F9" }}>
        <ReconnectBanner connection={connection} />
        <NudgeSlider value={me?.nudgeMs ?? 0} onCommit={(ms) => client.nudgeSelf(ms)} label="Sound early or late?" dark />
        <button
          onClick={() => client.audio.setMuted(!muted)}
          className="flex h-12 items-center justify-center rounded-xl border font-semibold"
          style={{ borderColor: "var(--border)", background: muted ? "#F1F5F9" : "transparent", color: muted ? "#0B0F14" : "#F1F5F9" }}
        >
          {muted ? "Unmute my phone" : "Mute my phone"}
        </button>
      </div>
    </main>
  );
}
