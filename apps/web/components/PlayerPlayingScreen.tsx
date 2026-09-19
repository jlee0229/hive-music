"use client";

import type { ClientRecord, RoomState } from "@hive/protocol";
import { ROLE_COLORS } from "@hive/protocol";
import type { ConnectionState, HiveClient, SyncStatus } from "@hive/sync-client";
import { formatMs, formatTrackTime } from "@/lib/hive/derive";
import { ReconnectBanner } from "@/components/ReconnectBanner";

/**
 * Full-screen role color, beat pulse and the nudge slider. Built out in gate F3; this placeholder
 * carries enough of the contract (role color, sync pill, name/code) to unblock F1's Ready → Playing transition.
 */
export function PlayerPlayingScreen({
  room,
  me,
  status,
  connection,
  roomCode,
}: {
  client: HiveClient;
  room: RoomState;
  me: ClientRecord | null;
  status: SyncStatus;
  connection: ConnectionState;
  roomCode: string;
  name: string;
}) {
  const assignment = me?.assignment ?? null;
  const roleColor = assignment ? ROLE_COLORS[assignment.role] : ROLE_COLORS.unison;

  return (
    <main
      className="flex min-h-dvh flex-col justify-between"
      style={{ background: roleColor, color: "#0B0F14", padding: "52px 24px 28px" }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[13px] tracking-widest opacity-80">
          HIVE · {roomCode}
        </span>
        <span className="font-mono flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px]" style={{ background: "rgba(11,15,20,0.35)", color: "#F1F5F9" }}>
          {formatMs(status.syncErrMs)}
        </span>
      </div>
      <div className="flex flex-col items-center gap-2.5">
        <span className="text-[13px] tracking-[0.22em] opacity-75">YOU ARE</span>
        <span className="font-display text-[64px] leading-none font-extrabold tracking-tight uppercase">
          {assignment?.label ?? "Unison"}
        </span>
        <span className="text-[15px] opacity-80">
          {room.track?.title ?? "—"} · {formatTrackTime(0)}
        </span>
      </div>
      <ReconnectBanner connection={connection} />
    </main>
  );
}
